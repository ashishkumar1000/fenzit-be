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
  'id, job_number, tenant_id, customer_id, technician_id, service_location, service_type, scheduled_start, scheduled_end, status, completed_at, current_step, priority, require_completion_photo, description, notes_for_technician, created_at, updated_at';
const JOBS_PAGE_SIZE = 50;
// Cursor scope — a cursor minted for another paginated endpoint (e.g. the jobs
// list, which also keys on created_at) is rejected (400) here.
const PROFILE_JOBS_CURSOR_SCOPE: CursorScope = 'profile-jobs';

export interface TenantSummary {
  id: string;
  companyName: string;
  gstin: string | null;
  address: string | null;
  stateCode: string;
  serviceCategories: string[];
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
  jobs: PaginatedResponse<JobResponse>;
  jobCounts: JobCounts;
}

export interface TechnicianProfileResponse extends UserProfileBase {
  role: Role.TECHNICIAN;
  skills: string[];
  skillIds: string[];
  jobs: PaginatedResponse<JobResponse>;
  jobCounts: JobCounts;
}

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
  service_categories: string[];
  upi_vpa: string | null;
}

// PostgREST embeds a to-one/to-many related resource; normalize both possible
// shapes when flattening skills (mirrors UserSkillRow in jobs.service.ts).
interface TenantSkillEmbed {
  id: string;
  name: string;
}

interface UserSkillsEmbedRow {
  tenant_skills: TenantSkillEmbed | TenantSkillEmbed[] | null;
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
          jobs: new PaginatedResponse<JobResponse>([], null),
          jobCounts: EMPTY_JOB_COUNTS,
        };
      }
      return {
        ...base,
        role: Role.OWNER,
        technicians: [],
        technicianCount: 0,
        customers: new PaginatedResponse<CustomerListItem>([], null),
        jobs: new PaginatedResponse<JobResponse>([], null),
        jobCounts: EMPTY_JOB_COUNTS,
      };
    }

    const tenantId = ownRow.tenant_id;

    const { data: tenantRow, error: tenantError } = await admin
      .from('tenants')
      .select(
        'id, company_name, gstin, address, state_code, service_categories, upi_vpa',
      )
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
      serviceCategories: tenantRow.service_categories ?? [],
      upiVpa: tenantRow.upi_vpa,
    };

    if (ownRow.role === Role.TECHNICIAN) {
      const [skills, jobs, jobCounts] = await Promise.all([
        this.getOwnSkills(admin, user.userId, tenantId),
        this.listProfileJobs(
          tenantId,
          user.userId,
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
      this.listProfileJobs(tenantId, null, query.jobsCursor, query.jobsLimit),
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
        'id, name, country_code, phone_number, status, created_at, user_skills(tenant_skills(id, name))',
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
    tenantId: string,
  ): Promise<TenantSkillEmbed[]> {
    const { data, error } = await admin
      .from('user_skills')
      .select('tenant_skills!inner(id, name)')
      .eq('user_id', userId)
      .eq('tenant_skills.tenant_id', tenantId);

    if (error) {
      this.logger.error('Failed to fetch own skills for profile:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to fetch profile',
      });
    }

    return this.flattenSkills(data ?? []);
  }

  private flattenSkills(rows: UserSkillsEmbedRow[]): TenantSkillEmbed[] {
    return rows
      .flatMap((r) => {
        const ts = r.tenant_skills;
        if (Array.isArray(ts)) return ts;
        return ts ? [ts] : [];
      })
      .filter((s): s is TenantSkillEmbed => Boolean(s?.name));
  }

  /**
   * Full (not day-scoped) cursor-paginated job list for the profile endpoint.
   * Mirrors jobs.service.listJobs' cursor mechanics, minus the IST-day window —
   * this is a profile/history view, not the "today's jobs" operational view.
   */
  private async listProfileJobs(
    tenantId: string,
    technicianId: string | null,
    cursor?: string,
    limit?: number,
  ): Promise<PaginatedResponse<JobResponse>> {
    const admin = this.supabaseClientFactory.createAdmin();
    const pageSize = limit ?? JOBS_PAGE_SIZE;

    let qb = admin.from('jobs').select(JOB_COLUMNS).eq('tenant_id', tenantId);

    if (technicianId) {
      qb = qb.eq('technician_id', technicianId);
    }

    if (cursor) {
      const c = decodeCursor(cursor, PROFILE_JOBS_CURSOR_SCOPE);
      qb = qb.or(
        `created_at.lt.${c.createdAt},and(created_at.eq.${c.createdAt},id.lt.${c.id})`,
      );
    }

    const { data, error } = await qb
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(pageSize + 1);

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
        ? encodeCursor(last.id, last.created_at, PROFILE_JOBS_CURSOR_SCOPE)
        : null;

    return new PaginatedResponse(
      pageRows.map((row) => this.jobsService.toResponse(row)),
      nextCursor,
    );
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
