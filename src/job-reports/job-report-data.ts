import {
  BadRequestException,
  InternalServerErrorException,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { ErrorCode } from '../common/enums/error-code.enum';
import { getIstDayRange } from '../common/utils/ist-day-range.util';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { pageAllRows } from './page-all-rows';
import type { MemberFact, ReportJob } from './job-report-rules';

const logger = new Logger('JobReportData');

/** The report window: IST calendar days, inclusive, as UTC instants. */
export interface ReportWindow {
  from: string;
  to: string;
  start: Date;
  end: Date;
}

const MAX_WINDOW_DAYS = 366;
const DAY_MS = 24 * 60 * 60 * 1000;

/** YYYY-MM-DD that is a real calendar day (rejects 2026-02-30, 2026-13-01). */
export function isRealDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === mo - 1 &&
    dt.getUTCDate() === d
  );
}

/** The IST calendar day (YYYY-MM-DD) that contains `now`. */
export function istDateOf(now: Date): string {
  return new Date(now.getTime() + 5.5 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/**
 * Resolves `from` / `to` (both optional) into an IST window. Default: the last
 * 30 IST days including today. A window that is not real dates, runs backwards,
 * or is longer than 366 days is refused with a plain-English reason (422).
 */
export function resolveReportWindow(
  query: { from?: string; to?: string },
  now: Date = new Date(),
): ReportWindow {
  const to = query.to ?? istDateOf(now);
  const from = query.from ?? shiftDate(to, -29);
  if (!isRealDate(from) || !isRealDate(to)) {
    throw new UnprocessableEntityException({
      error_code: ErrorCode.VALIDATION_ERROR,
      message: 'from and to must be real calendar dates (YYYY-MM-DD)',
    });
  }
  const spanDays =
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS;
  if (spanDays < 0) {
    throw new UnprocessableEntityException({
      error_code: ErrorCode.VALIDATION_ERROR,
      message: 'from must be on or before to',
    });
  }
  if (spanDays + 1 > MAX_WINDOW_DAYS) {
    throw new UnprocessableEntityException({
      error_code: ErrorCode.VALIDATION_ERROR,
      message: 'The report window can be at most 366 days',
    });
  }
  return {
    from,
    to,
    // Noon IST on each day (06:30Z) sits inside that IST day, so the
    // day's own range is found without new IST arithmetic.
    start: getIstDayRange(new Date(`${from}T06:30:00.000Z`)).start,
    end: getIstDayRange(new Date(`${to}T06:30:00.000Z`)).end,
  };
}

export function requireCompany(user: RequestUser): string {
  if (!user.tenantId) {
    throw new BadRequestException({
      error_code: ErrorCode.VALIDATION_ERROR,
      message: 'Company setup required before running reports',
    });
  }
  return user.tenantId;
}

interface MembershipRow {
  user_id: string;
  role: MemberFact['role'];
  status: MemberFact['status'];
  can_create_jobs: boolean;
  users: { name: string | null } | { name: string | null }[] | null;
}

/**
 * Everyone who has ever been a member of the company, removed ones included, so a
 * past employee's jobs still name them. Disabled people are kept too.
 */
export async function loadMembers(
  admin: SupabaseClient,
  tenantId: string,
): Promise<Map<string, MemberFact>> {
  const { data, error } = await admin
    .from('memberships')
    .select(
      'user_id, role, status, can_create_jobs, users!memberships_user_id_fkey(name)',
    )
    .eq('tenant_id', tenantId);
  if (error) {
    logger.error('Failed to load company members for reports', { error });
    throw new InternalServerErrorException({
      error_code: ErrorCode.INTERNAL_SERVER_ERROR,
      message: 'Failed to load reports',
    });
  }
  const map = new Map<string, MemberFact>();
  for (const row of (data ?? []) as unknown as MembershipRow[]) {
    const u = Array.isArray(row.users) ? row.users[0] : row.users;
    map.set(row.user_id, {
      role: row.role,
      status: row.status,
      canCreateJobs: row.can_create_jobs,
      name: u?.name ?? null,
    });
  }
  return map;
}

interface JobReportRow {
  id: string;
  job_number: string;
  created_by: string | null;
  status: string;
  created_at: string;
  decided_at: string | null;
  rejection_reason: string | null;
}

/**
 * Every job created in the window, optionally by one creator. Reads page by page
 * (see page-all-rows.ts) so a busy company is not silently cut at 1000 rows.
 */
export async function loadWindowJobs(
  admin: SupabaseClient,
  tenantId: string,
  window: ReportWindow,
  createdBy?: string,
): Promise<ReportJob[]> {
  const rows = await pageAllRows<JobReportRow>((from, to) => {
    let qb = admin
      .from('jobs')
      .select(
        'id, job_number, created_by, status, created_at, decided_at, rejection_reason',
      )
      .eq('tenant_id', tenantId)
      .gte('created_at', window.start.toISOString())
      .lt('created_at', window.end.toISOString());
    if (createdBy) qb = qb.eq('created_by', createdBy);
    return qb.order('id', { ascending: true }).range(from, to);
  });
  return rows.map((r) => ({
    id: r.id,
    jobNumber: r.job_number,
    createdBy: r.created_by,
    status: r.status,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
    rejectionReason: r.rejection_reason,
  }));
}
