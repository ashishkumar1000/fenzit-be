import { BadRequestException } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ErrorCode } from '../../common/enums/error-code.enum';
import type { ReportFetchContext } from './report-definition';

/**
 * Data fetcher for the Technician Job Activity report (FR16) — story 12-5.
 *
 * Tenant-scoped reads through the admin Supabase client handed in via
 * ReportFetchContext (NFR5: the module imports nothing from jobs/customers/
 * users modules — status/priority values are mirrored as local unions).
 * Every list query is paginated (Supabase's default 1000-row cap) so the
 * REPORT_MAX_JOBS oversize guard is the only truncation point — and it
 * fails with report_too_large, never silently.
 */

/** Mirrored job status values (jobs/enums — not imported, NFR5). */
export type ActivityJobStatus =
  'scheduled' | 'in_progress' | 'completed' | 'cancelled';

export type ActivityJobPriority = 'normal' | 'urgent';

/** One job in the report range, with resolved names and attachment counts. */
export interface FetchedJob {
  id: string;
  jobNumber: string;
  technicianId: string;
  customerId: string;
  customerName: string;
  skillName: string | null;
  status: ActivityJobStatus;
  priority: ActivityJobPriority;
  /** ISO instants as stored (timestamptz). */
  scheduledStart: string;
  scheduledEnd: string | null;
  completedAt: string | null;
  photoCount: number;
  signatureCount: number;
}

export interface ActivityTechnician {
  id: string;
  name: string;
}

/** Everything the template needs — the range rides along for the header. */
export interface TechnicianJobActivityData {
  tenant: { companyName: string; address: string | null };
  range: { startDate: string; endDate: string };
  /** Sections render in this order; includes zero-job technicians (FR18). */
  technicians: ActivityTechnician[];
  jobs: FetchedJob[];
}

interface RawJobRow {
  id: string;
  job_number: string;
  technician_id: string;
  customer_id: string;
  status: string;
  priority: string;
  scheduled_start: string;
  scheduled_end: string | null;
  completed_at: string | null;
  customers: { name: string } | null;
  skills: { name: string } | null;
}

const JOB_COLUMNS =
  'id, job_number, technician_id, customer_id, status, priority, ' +
  'scheduled_start, scheduled_end, completed_at, customers(name), skills(name)';

const PAGE_SIZE = 1000;
const IN_CHUNK_SIZE = 500;

const IST_OFFSET_SUFFIX = '+05:30';

/** IST day bounds for the inclusive [start_date, end_date] window. */
function istDayBounds(
  startDate: string,
  endDate: string,
): { startIso: string; endExclusiveIso: string } {
  const start = new Date(`${startDate}T00:00:00${IST_OFFSET_SUFFIX}`);
  const endExclusive = new Date(
    new Date(`${endDate}T00:00:00${IST_OFFSET_SUFFIX}`).getTime() + 86_400_000,
  );
  return {
    startIso: start.toISOString(),
    endExclusiveIso: endExclusive.toISOString(),
  };
}

function tooLarge(): BadRequestException {
  return new BadRequestException({
    error_code: ErrorCode.REPORT_TOO_LARGE,
    message: 'Report range contains too many jobs',
  });
}

async function fetchTenant(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<TechnicianJobActivityData['tenant']> {
  const { data, error } = await supabase
    .from('tenants')
    .select('company_name, address')
    .eq('id', tenantId)
    .single<{ company_name: string; address: string | null }>();
  if (error || !data) {
    throw new Error(`Failed to fetch tenant for report: ${error?.message}`);
  }
  return { companyName: data.company_name, address: data.address };
}

/** Paged jobs in the IST window; enforces the maxJobs guard (FR2). */
async function fetchJobsInRange(
  supabase: SupabaseClient,
  tenantId: string,
  bounds: { startIso: string; endExclusiveIso: string },
  maxJobs: number,
): Promise<RawJobRow[]> {
  // A fresh builder per page (supabase-js builders are single-use; the
  // exact count rides along on every page — only the first's is read).
  const buildQuery = () =>
    supabase
      .from('jobs')
      .select(JOB_COLUMNS, { count: 'exact' })
      .eq('tenant_id', tenantId)
      .gte('scheduled_start', bounds.startIso)
      .lt('scheduled_start', bounds.endExclusiveIso)
      .order('scheduled_start', { ascending: true });

  // The exact count is the single truncation check (FR2).
  const first = await buildQuery().range(0, PAGE_SIZE - 1);
  const { data, error, count } = first;
  if (error || !data) {
    throw new Error(`Failed to fetch jobs for report: ${error?.message}`);
  }
  if ((count ?? 0) > maxJobs) {
    throw tooLarge();
  }

  const rows = [...(data as unknown as RawJobRow[])];
  while (rows.length < (count ?? 0)) {
    const { data: pageRows, error: pageError } = await buildQuery().range(
      rows.length,
      rows.length + PAGE_SIZE - 1,
    );
    if (pageError || !pageRows) {
      throw new Error(
        `Failed to fetch jobs page for report: ${pageError?.message}`,
      );
    }
    if (pageRows.length === 0) break;
    rows.push(...(pageRows as unknown as RawJobRow[]));
  }
  return rows;
}

/**
 * Attachment counts per job (photos + signatures only — FR17). Responses can
 * exceed the IN-chunk size, so each chunk is itself paged.
 */
async function fetchAttachmentCounts(
  supabase: SupabaseClient,
  tenantId: string,
  jobIds: string[],
): Promise<Map<string, { photo: number; signature: number }>> {
  const counts = new Map<string, { photo: number; signature: number }>();
  for (let i = 0; i < jobIds.length; i += IN_CHUNK_SIZE) {
    const chunk = jobIds.slice(i, i + IN_CHUNK_SIZE);
    let from = 0;
    for (;;) {
      const { data, error } = await supabase
        .from('attachments')
        .select('job_id, attachment_type')
        .eq('tenant_id', tenantId)
        .in('job_id', chunk)
        .range(from, from + PAGE_SIZE - 1);
      if (error || !data) {
        throw new Error(
          `Failed to fetch attachments for report: ${error?.message}`,
        );
      }
      for (const row of data as { job_id: string; attachment_type: string }[]) {
        if (
          row.attachment_type !== 'photo' &&
          row.attachment_type !== 'signature'
        ) {
          continue;
        }
        const entry = counts.get(row.job_id) ?? { photo: 0, signature: 0 };
        if (row.attachment_type === 'photo') entry.photo += 1;
        else entry.signature += 1;
        counts.set(row.job_id, entry);
      }
      if ((data as unknown[]).length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }
  }
  return counts;
}

/** Technician display names, tenant-scoped (chunked IN queries). */
async function fetchTechnicianNames(
  supabase: SupabaseClient,
  tenantId: string,
  technicianIds: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (let i = 0; i < technicianIds.length; i += IN_CHUNK_SIZE) {
    const chunk = technicianIds.slice(i, i + IN_CHUNK_SIZE);
    const { data, error } = await supabase
      .from('users')
      .select('id, name')
      .eq('tenant_id', tenantId)
      .in('id', chunk);
    if (error || !data) {
      throw new Error(
        `Failed to fetch technicians for report: ${error?.message}`,
      );
    }
    for (const row of data as { id: string; name: string }[]) {
      names.set(row.id, row.name);
    }
  }
  return names;
}

/**
 * Full fetch for one technician_job_activity request: tenant identity, the
 * range's jobs (with names + attachment counts), and the section list.
 * Selected technicians with zero jobs keep their section (FR18), so the
 * technician list is the union of the selection and the jobs' technicians.
 */
export async function fetchTechnicianJobActivityData(
  ctx: ReportFetchContext,
): Promise<TechnicianJobActivityData> {
  const { supabase, tenantId, params } = ctx;
  const bounds = istDayBounds(params.start_date, params.end_date);

  const [tenant, rawJobs] = await Promise.all([
    fetchTenant(supabase, tenantId),
    fetchJobsInRange(supabase, tenantId, bounds, ctx.maxJobs),
  ]);

  const technicianIds = [
    ...new Set([
      ...params.technician_ids,
      ...rawJobs.map((j) => j.technician_id),
    ]),
  ];
  const [technicianNames, attachmentCounts] = await Promise.all([
    fetchTechnicianNames(supabase, tenantId, technicianIds),
    fetchAttachmentCounts(
      supabase,
      tenantId,
      rawJobs.map((j) => j.id),
    ),
  ]);

  const technicians: ActivityTechnician[] = technicianIds.map((id) => ({
    id,
    // Service-validated ids always resolve; a missing row is a display fault,
    // not a generation failure.
    name: technicianNames.get(id) ?? 'Unknown technician',
  }));

  const jobs: FetchedJob[] = rawJobs.map((j) => {
    const counts = attachmentCounts.get(j.id) ?? { photo: 0, signature: 0 };
    return {
      id: j.id,
      jobNumber: j.job_number,
      technicianId: j.technician_id,
      customerId: j.customer_id,
      customerName: j.customers?.name ?? 'Unknown customer',
      skillName: j.skills?.name ?? null,
      status: j.status as ActivityJobStatus,
      priority: j.priority as ActivityJobPriority,
      scheduledStart: j.scheduled_start,
      scheduledEnd: j.scheduled_end,
      completedAt: j.completed_at,
      photoCount: counts.photo,
      signatureCount: counts.signature,
    };
  });

  return {
    tenant,
    range: { startDate: params.start_date, endDate: params.end_date },
    technicians,
    jobs,
  };
}
