import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { ErrorCode } from '../common/enums/error-code.enum';
import { Role } from '../common/enums/role.enum';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { PaginatedResponse } from '../common/dto/paginated-response.dto';
import {
  encodeCursor,
  decodeCursor,
  CursorScope,
} from '../common/utils/cursor.util';
import { getIstDayRange } from '../common/utils/ist-day-range.util';
import {
  CustomersService,
  CustomerListItem,
} from '../customers/customers.service';
import { JobsService, JobResponse, JobRow } from '../jobs/jobs.service';
import { JobStatus } from '../jobs/enums/job-status.enum';
import { GetProfileQueryDto } from './dto/get-profile-query.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';

// Mirrors JOB_DETAIL_COLUMNS in jobs.service.ts — kept as a separate literal here
// (rather than imported) so this service's `as JobRow[]` cast has the matching
// column-literal type, same reasoning as listJobs in jobs.service.ts.
const JOB_COLUMNS =
  'id, job_number, tenant_id, customer_id, technician_id, service_location, scheduled_start, scheduled_end, status, completed_at, current_step, priority, description, notes_for_technician, created_at, updated_at';
const JOBS_PAGE_SIZE = 50;
// Cursor scope — a cursor minted for another paginated endpoint (e.g. the jobs
// list, which also keys on created_at) is rejected (400) here.
const PROFILE_JOBS_CURSOR_SCOPE: CursorScope = 'profile-jobs';
// Story 3.9 — the today scope keys on scheduled_start (different column and
// sort direction than the default), so its cursors carry their own scope tag:
// a cursor minted for one profile scope is rejected (400) on the other, the
// same rule as the jobs-list timeline scopes.
const PROFILE_JOBS_TODAY_CURSOR_SCOPE: CursorScope = 'profile-jobs-today';

export interface TenantSummary {
  id: string;
  companyName: string;
  gstin: string | null;
  address: string | null;
  stateCode: string;
  upiVpa: string | null;
}

// Story 3.7 — dashboard counts on the job timeline. The three day-buckets
// (today/upcoming/overdue) are mutually exclusive (upcoming starts at the start
// of tomorrow IST), so their sum + completed + cancelled = all jobs. They are
// ACTION counts: finished jobs are excluded from today/overdue (completed/
// cancelled are the all-time totals). Known accepted gap: a FUTURE-dated job
// advanced early to in_progress matches none of the three day-buckets.
export interface JobCounts {
  today: number;
  upcoming: number;
  overdue: number;
  completed: number;
  cancelled: number;
}

export interface TechnicianSummary {
  id: string;
  name: string | null;
  countryCode: string;
  phoneNumber: string;
  status: string;
  skills: string[];
  skillIds: string[];
  createdAt: string;
}

interface UserProfileBase {
  id: string;
  name: string | null;
  countryCode: string;
  phoneNumber: string;
  status: string;
  tenant: TenantSummary | null;
}

export interface OwnerProfileResponse extends UserProfileBase {
  role: Role.OWNER;
  technicians: TechnicianSummary[];
  technicianCount: number;
  customers: PaginatedResponse<CustomerListItem>;
  jobs: PaginatedResponse<ProfileJobResponse>;
  jobCounts: JobCounts;
}

export interface TechnicianProfileResponse extends UserProfileBase {
  role: Role.TECHNICIAN;
  skills: string[];
  skillIds: string[];
  jobs: PaginatedResponse<ProfileJobResponse>;
  jobCounts: JobCounts;
}

// Story 3.9 — every profile job row embeds the same technician/customer
// summaries the GET /jobs/:id detail embed uses (jobs.service.toDetailResponse),
// so the Home dispatch view needs no on-device id→name joins. JobResponse
// itself is NOT widened — GET /jobs keeps its exact shape.
export interface ProfileTechnicianEmbed {
  id: string;
  name: string | null;
  countryCode: string;
  phoneNumber: string;
  skills: string[];
}

export interface ProfileCustomerEmbed {
  id: string;
  name: string | null;
  countryCode: string;
  phoneNumber: string;
  address: string | null;
  city: string | null;
}

export type ProfileJobResponse = JobResponse & {
  technician: ProfileTechnicianEmbed;
  customer: ProfileCustomerEmbed;
};

export type UserProfileResponse =
  OwnerProfileResponse | TechnicianProfileResponse;

interface OwnUserRow {
  id: string;
  name: string | null;
  country_code: string;
  phone_number: string;
  role: Role;
  status: string;
  tenant_id: string | null;
}

interface TenantRow {
  id: string;
  company_name: string;
  gstin: string | null;
  address: string | null;
  state_code: string;
  upi_vpa: string | null;
}

// PostgREST embeds a to-one/to-many related resource; normalize both possible
// shapes when flattening skills (mirrors UserSkillRow in jobs.service.ts).
interface SkillEmbed {
  id: string;
  name: string;
}

interface UserSkillsEmbedRow {
  skills: SkillEmbed | SkillEmbed[] | null;
}

interface TechnicianListRow {
  id: string;
  name: string | null;
  country_code: string;
  phone_number: string;
  status: string;
  created_at: string;
  user_skills: UserSkillsEmbedRow[] | null;
}

const EMPTY_JOB_COUNTS: JobCounts = {
  today: 0,
  upcoming: 0,
  overdue: 0,
  completed: 0,
  cancelled: 0,
};

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly supabaseClientFactory: SupabaseClientFactory,
    private readonly customersService: CustomersService,
    private readonly jobsService: JobsService,
  ) {}

  async getMyProfile(
    user: RequestUser,
    query: GetProfileQueryDto,
  ): Promise<UserProfileResponse> {
    const admin = this.supabaseClientFactory.createAdmin();

    const { data: ownRow, error: ownError } = await admin
      .from('users')
      .select('id, name, country_code, phone_number, role, status, tenant_id')
      .eq('id', user.userId)
      .single<OwnUserRow>();

    if (ownError || !ownRow) {
      this.logger.error('Failed to fetch own user profile:', {
        error: ownError,
        userId: user.userId,
      });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to fetch profile',
      });
    }

    const base: UserProfileBase = {
      id: ownRow.id,
      name: ownRow.name,
      countryCode: ownRow.country_code,
      phoneNumber: ownRow.phone_number,
      status: ownRow.status,
      tenant: null,
    };

    // Pre-onboarding owner (or a data state with no tenant yet) — return a
    // minimal profile rather than erroring; "get my profile" should work
    // even before company setup, unlike the write endpoints in auth/jobs.
    if (!ownRow.tenant_id) {
      if (ownRow.role === Role.TECHNICIAN) {
        return {
          ...base,
          role: Role.TECHNICIAN,
          skills: [],
          skillIds: [],
          jobs: new PaginatedResponse<ProfileJobResponse>([], null),
          jobCounts: EMPTY_JOB_COUNTS,
        };
      }
      return {
        ...base,
        role: Role.OWNER,
        technicians: [],
        technicianCount: 0,
        customers: new PaginatedResponse<CustomerListItem>([], null),
        jobs: new PaginatedResponse<ProfileJobResponse>([], null),
        jobCounts: EMPTY_JOB_COUNTS,
      };
    }

    const tenantId = ownRow.tenant_id;

    const { data: tenantRow, error: tenantError } = await admin
      .from('tenants')
      .select('id, company_name, gstin, address, state_code, upi_vpa')
      .eq('id', tenantId)
      .single<TenantRow>();

    if (tenantError || !tenantRow) {
      this.logger.error('Failed to fetch tenant for profile:', {
        error: tenantError,
        tenantId,
      });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to fetch profile',
      });
    }

    const tenant: TenantSummary = {
      id: tenantRow.id,
      companyName: tenantRow.company_name,
      gstin: tenantRow.gstin,
      address: tenantRow.address,
      stateCode: tenantRow.state_code,
      upiVpa: tenantRow.upi_vpa,
    };

    if (ownRow.role === Role.TECHNICIAN) {
      const [skills, jobs, jobCounts] = await Promise.all([
        this.getOwnSkills(admin, user.userId),
        this.listProfileJobs(
          tenantId,
          user.userId,
          query.jobsScope,
          query.jobsCursor,
          query.jobsLimit,
        ),
        this.getJobCounts(tenantId, user.userId),
      ]);

      return {
        ...base,
        role: Role.TECHNICIAN,
        tenant,
        skills: skills.map((s) => s.name),
        skillIds: skills.map((s) => s.id),
        jobs,
        jobCounts,
      };
    }

    const [technicians, customers, jobs, jobCounts] = await Promise.all([
      this.listTechnicians(admin, tenantId),
      // Pass the DB-fresh tenantId (not the possibly-stale JWT claim on `user`)
      // so this call can never disagree with the tenant/technicians/jobs above —
      // e.g. right after setupCompany mints a new token the client hasn't
      // swapped in yet, `user.tenantId` could still be null.
      this.customersService.listCustomers(
        { ...user, tenantId },
        { cursor: query.customersCursor, limit: query.customersLimit },
      ),
      this.listProfileJobs(
        tenantId,
        null,
        query.jobsScope,
        query.jobsCursor,
        query.jobsLimit,
      ),
      this.getJobCounts(tenantId, null),
    ]);

    return {
      ...base,
      role: Role.OWNER,
      tenant,
      technicians,
      technicianCount: technicians.length,
      customers,
      jobs,
      jobCounts,
    };
  }

  async updateMyProfile(
    user: RequestUser,
    dto: UpdateProfileDto,
  ): Promise<UserProfileResponse> {
    const admin = this.supabaseClientFactory.createAdmin();

    const { error } = await admin
      .from('users')
      .update({ name: dto.name })
      .eq('id', user.userId);

    if (error) {
      this.logger.error('Failed to update own name:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to update profile',
      });
    }

    return this.getMyProfile(user, {});
  }

  private async listTechnicians(
    admin: SupabaseClient,
    tenantId: string,
  ): Promise<TechnicianSummary[]> {
    const { data, error } = await admin
      .from('users')
      .select(
        'id, name, country_code, phone_number, status, created_at, user_skills(skills(id, name))',
      )
      .eq('tenant_id', tenantId)
      .eq('role', Role.TECHNICIAN)
      .order('created_at', { ascending: true });

    if (error) {
      this.logger.error('Failed to list technicians for profile:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to fetch profile',
      });
    }

    const rows = (data ?? []) as TechnicianListRow[];
    return rows.map((row) => {
      const skills = this.flattenSkills(row.user_skills ?? []);
      return {
        id: row.id,
        name: row.name,
        countryCode: row.country_code,
        phoneNumber: row.phone_number,
        status: row.status,
        skills: skills.map((s) => s.name),
        skillIds: skills.map((s) => s.id),
        createdAt: row.created_at,
      };
    });
  }

  private async getOwnSkills(
    admin: SupabaseClient,
    userId: string,
  ): Promise<SkillEmbed[]> {
    const { data, error } = await admin
      .from('user_skills')
      .select('skills!inner(id, name)')
      .eq('user_id', userId);

    if (error) {
      this.logger.error('Failed to fetch own skills for profile:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to fetch profile',
      });
    }

    return this.flattenSkills(data ?? []);
  }

  private flattenSkills(rows: UserSkillsEmbedRow[]): SkillEmbed[] {
    return rows
      .flatMap((r) => {
        const s = r.skills;
        if (Array.isArray(s)) return s;
        return s ? [s] : [];
      })
      .filter((skill): skill is SkillEmbed => Boolean(skill?.name));
  }

  /**
   * Cursor-paginated job list for the profile endpoint, with technician and
   * customer embeds on every row (Story 3.9).
   *
   * Default scope ('all', or jobsScope omitted): full history, created_at DESC
   * — byte-for-byte the pre-3.9 query mechanics.
   * Scope 'today': the exclusive IST day window on scheduled_start with no
   * status filter — the same WINDOW mechanics GET /jobs?scope=today uses
   * (Story 3.7; the FE drops completed/cancelled rows from display, the
   * payload stays honest about the window's contents). Like the jobs list,
   * a technician's today view ORs in their in_progress jobs regardless of the
   * window; the owner view keeps the pure window. The SORT intentionally
   * differs: GET /jobs?scope=today keys on created_at DESC, while this
   * dispatch view sorts scheduled_start ASC so the page reads soonest-first.
   * A cursor minted for one scope is rejected (400) on the other.
   * A today cursor replayed after IST midnight still passes the scope check
   * but lands outside the now-shifted window — it returns a short/empty page
   * (never wrong rows); clients refetch page one on the next open.
   */
  private async listProfileJobs(
    tenantId: string,
    technicianId: string | null,
    jobsScope: GetProfileQueryDto['jobsScope'],
    cursor?: string,
    limit?: number,
  ): Promise<PaginatedResponse<ProfileJobResponse>> {
    const admin = this.supabaseClientFactory.createAdmin();
    const pageSize = limit ?? JOBS_PAGE_SIZE;
    const isToday = jobsScope === 'today';
    const cursorScope = isToday
      ? PROFILE_JOBS_TODAY_CURSOR_SCOPE
      : PROFILE_JOBS_CURSOR_SCOPE;

    let qb = admin.from('jobs').select(JOB_COLUMNS).eq('tenant_id', tenantId);

    if (technicianId) {
      qb = qb.eq('technician_id', technicianId);
    }

    if (isToday) {
      // Zero new IST arithmetic — copy of the jobs-list today window,
      // including its in_progress OR branch for the technician's own view: an
      // active job must not vanish from the profile's Today page when its slot
      // crosses midnight IST. Owners (technicianId=null) keep the pure
      // day-window view.
      const range = getIstDayRange();
      if (technicianId) {
        qb = qb.or(
          `and(scheduled_start.gte.${range.start.toISOString()},scheduled_start.lt.${range.end.toISOString()}),status.eq.${JobStatus.IN_PROGRESS}`,
        );
      } else {
        qb = qb
          .gte('scheduled_start', range.start.toISOString())
          .lt('scheduled_start', range.end.toISOString());
      }
    }

    if (cursor) {
      const c = decodeCursor(cursor, cursorScope);
      qb = isToday
        ? qb.or(
            `scheduled_start.gt.${c.createdAt},and(scheduled_start.eq.${c.createdAt},id.gt.${c.id})`,
          )
        : qb.or(
            `created_at.lt.${c.createdAt},and(created_at.eq.${c.createdAt},id.lt.${c.id})`,
          );
    }

    const { data, error } = await (
      isToday
        ? qb
            .order('scheduled_start', { ascending: true })
            .order('id', { ascending: true })
        : qb
            .order('created_at', { ascending: false })
            .order('id', { ascending: false })
    ).limit(pageSize + 1);

    if (error) {
      this.logger.error('Failed to list jobs for profile:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to fetch profile',
      });
    }

    const rows = (data ?? []) as JobRow[];
    const hasMore = rows.length > pageSize;
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
    const last = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor(
            last.id,
            isToday ? last.scheduled_start : last.created_at,
            cursorScope,
          )
        : null;

    const enriched = await this.embedProfileJobs(admin, tenantId, pageRows);

    return new PaginatedResponse(enriched, nextCursor);
  }

  /**
   * Story 3.9 — batched technician/customer embeds for a profile jobs page.
   * Three in-filtered queries total regardless of page size (users, skills,
   * customers); row↔name joins happen in memory. Embed shapes mirror the
   * GET /jobs/:id detail embed (jobs.service.toDetailResponse).
   */
  private async embedProfileJobs(
    admin: SupabaseClient,
    tenantId: string,
    rows: JobRow[],
  ): Promise<ProfileJobResponse[]> {
    if (rows.length === 0) return [];

    const techIds = [...new Set(rows.map((r) => r.technician_id))];
    const customerIds = [...new Set(rows.map((r) => r.customer_id))];

    const [usersRes, skillsRes, customersRes] = await Promise.all([
      admin
        .from('users')
        .select('id, name, country_code, phone_number')
        .in('id', techIds)
        .eq('tenant_id', tenantId),
      admin
        .from('user_skills')
        .select('user_id, skills!inner(name)')
        .in('user_id', techIds),
      admin
        .from('customers')
        .select('id, name, country_code, phone_number, address, city')
        .eq('tenant_id', tenantId)
        .in('id', customerIds),
    ]);

    if (usersRes.error || skillsRes.error || customersRes.error) {
      this.logger.error('Failed to fetch profile job embeds:', {
        usersError: usersRes.error,
        skillsError: skillsRes.error,
        customersError: customersRes.error,
      });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to fetch profile',
      });
    }

    type EmbedUserRow = {
      id: string;
      name: string | null;
      country_code: string;
      phone_number: string;
    };
    type EmbedSkillRow = { user_id: string } & UserSkillsEmbedRow;
    type EmbedCustomerRow = {
      id: string;
      name: string | null;
      country_code: string;
      phone_number: string;
      address: string | null;
      city: string | null;
    };

    const usersById = new Map(
      ((usersRes.data ?? []) as EmbedUserRow[]).map((u) => [u.id, u]),
    );
    const skillsByUser = new Map<string, string[]>();
    for (const row of (skillsRes.data ?? []) as EmbedSkillRow[]) {
      for (const skill of this.flattenSkills([row])) {
        const list = skillsByUser.get(row.user_id) ?? [];
        list.push(skill.name);
        skillsByUser.set(row.user_id, list);
      }
    }
    const customersById = new Map(
      ((customersRes.data ?? []) as EmbedCustomerRow[]).map((c) => [c.id, c]),
    );

    // A missing users/customers row under an FK can only be a mid-page
    // deletion (data anomaly). It degrades to an id-only embed below — but log
    // the specific ids so the condition is diagnosable from server logs alone
    // (same discipline as jobs detail's missing-embed 500).
    const missingTechIds = rows
      .map((r) => r.technician_id)
      .filter((id) => !usersById.has(id));
    const missingCustomerIds = rows
      .map((r) => r.customer_id)
      .filter((id) => !customersById.has(id));
    if (missingTechIds.length > 0 || missingCustomerIds.length > 0) {
      this.logger.warn('Profile job embeds reference missing rows:', {
        missingTechIds,
        missingCustomerIds,
      });
    }

    return rows.map((row) => {
      const tech = usersById.get(row.technician_id);
      const customer = customersById.get(row.customer_id);
      return {
        ...this.jobsService.toResponse(row),
        // technician_id is NOT NULL, so a missing users row can only be a data
        // anomaly — degrade to an id-only embed rather than dropping the key
        // (clients must never see an "unassigned" profile job).
        technician: {
          id: row.technician_id,
          name: tech?.name ?? null,
          countryCode: tech?.country_code ?? '',
          phoneNumber: tech?.phone_number ?? '',
          skills: skillsByUser.get(row.technician_id) ?? [],
        },
        customer: {
          id: row.customer_id,
          name: customer?.name ?? null,
          countryCode: customer?.country_code ?? '',
          phoneNumber: customer?.phone_number ?? '',
          address: customer?.address ?? null,
          city: customer?.city ?? null,
        },
      };
    });
  }

  private async getJobCounts(
    tenantId: string,
    technicianId: string | null,
  ): Promise<JobCounts> {
    const admin = this.supabaseClientFactory.createAdmin();

    // Same boundaries the jobs-list scopes use (Story 3.7): today's IST window
    // is [start, end); upcoming starts at range.end (start of tomorrow IST) and
    // overdue at range.start — the three day-buckets can never overlap.
    const range = getIstDayRange();
    const todayWindowStatuses = [JobStatus.SCHEDULED, JobStatus.IN_PROGRESS];

    // Five independent head:true, count:'exact' queries. Owner counts are
    // tenant-wide; a technician's are scoped to their own jobs.
    const queries = [
      {
        key: 'today' as const,
        build: () =>
          admin
            .from('jobs')
            .select('*', { count: 'exact', head: true })
            .eq('tenant_id', tenantId)
            .gte('scheduled_start', range.start.toISOString())
            .lt('scheduled_start', range.end.toISOString())
            .in('status', todayWindowStatuses),
      },
      {
        key: 'upcoming' as const,
        build: () =>
          admin
            .from('jobs')
            .select('*', { count: 'exact', head: true })
            .eq('tenant_id', tenantId)
            .gte('scheduled_start', range.end.toISOString())
            .eq('status', JobStatus.SCHEDULED),
      },
      {
        key: 'overdue' as const,
        build: () =>
          admin
            .from('jobs')
            .select('*', { count: 'exact', head: true })
            .eq('tenant_id', tenantId)
            .lt('scheduled_start', range.start.toISOString())
            .in('status', todayWindowStatuses),
      },
      {
        key: 'completed' as const,
        build: () =>
          admin
            .from('jobs')
            .select('*', { count: 'exact', head: true })
            .eq('tenant_id', tenantId)
            .eq('status', JobStatus.COMPLETED),
      },
      {
        key: 'cancelled' as const,
        build: () =>
          admin
            .from('jobs')
            .select('*', { count: 'exact', head: true })
            .eq('tenant_id', tenantId)
            .eq('status', JobStatus.CANCELLED),
      },
    ];

    const results = await Promise.all(
      queries.map((q) => {
        let qb = q.build();
        if (technicianId) {
          qb = qb.eq('technician_id', technicianId);
        }
        return qb;
      }),
    );

    for (const r of results) {
      if (r.error) {
        this.logger.error('Failed to count jobs for profile:', {
          error: r.error,
        });
        throw new InternalServerErrorException({
          error_code: ErrorCode.INTERNAL_SERVER_ERROR,
          message: 'Failed to fetch profile',
        });
      }
    }

    return {
      today: results[0].count ?? 0,
      upcoming: results[1].count ?? 0,
      overdue: results[2].count ?? 0,
      completed: results[3].count ?? 0,
      cancelled: results[4].count ?? 0,
    };
  }
}
