import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { ErrorCode } from '../common/enums/error-code.enum';
import { Role } from '../common/enums/role.enum';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { PaginatedResponse } from '../common/dto/paginated-response.dto';
import { encodeCursor, decodeCursor } from '../common/utils/cursor.util';
import { getIstDayRange } from '../common/utils/ist-day-range.util';
import { CustomersService } from '../customers/customers.service';
import { StorageService } from '../storage/storage.service';
import { CreateJobDto } from './dto/create-job.dto';
import { UpdateJobDto } from './dto/update-job.dto';
import { ListJobsQueryDto } from './dto/list-jobs-query.dto';
import { ServiceType } from './enums/service-type.enum';
import { JobStatus } from './enums/job-status.enum';
import { JobPriority } from './enums/job-priority.enum';

// TTL for presigned R2 read URLs surfaced in job detail. Regenerated fresh on
// every getJobDetail call, never stored (AC#18).
const ATTACHMENT_READ_URL_TTL_SECONDS = 3600; // 1 hour

export interface JobResponse {
  id: string;
  jobNumber: string;
  tenantId: string;
  customerId: string;
  technicianId: string;
  serviceLocation: string;
  serviceType: ServiceType;
  scheduledStart: string;
  scheduledEnd: string | null;
  status: JobStatus;
  currentStep: string | null;
  priority: JobPriority;
  requireCompletionPhoto: boolean;
  description: string | null;
  notesForTechnician: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A technician/customer profile embedded in the job-detail response. */
interface TechnicianProfile {
  id: string;
  name: string;
  countryCode: string;
  phoneNumber: string;
  skills: string[];
}

interface CustomerProfile {
  id: string;
  name: string;
  countryCode: string;
  phoneNumber: string;
  address: string | null;
  city: string | null;
}

/** One activity-log entry as returned by the job-detail endpoint. */
export interface ActivityLogEntry {
  id: string;
  eventType: string;
  actorId: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

/**
 * Placeholder for a job attachment. Story 3.6 finalizes this shape and populates
 * it (presigned R2 read URLs, 1-hour TTL, regenerated each call); until then the
 * detail endpoint returns `attachments: []`.
 */
export interface JobAttachmentResponse {
  id: string;
  type: string;
  // null when the presigned read URL could not be generated (transient storage
  // signing error). The rest of the job detail is still returned; the client
  // can refetch to retry the URL rather than the whole endpoint 500-ing.
  url: string | null;
  createdAt: string;
}

export interface JobDetailResponse extends JobResponse {
  technician: TechnicianProfile;
  customer: CustomerProfile;
  activityLog: ActivityLogEntry[];
  attachments: JobAttachmentResponse[];
}

export interface JobRow {
  id: string;
  job_number: string;
  tenant_id: string;
  customer_id: string;
  technician_id: string;
  service_location: string;
  service_type: ServiceType;
  scheduled_start: string;
  scheduled_end: string | null;
  status: JobStatus;
  current_step: string | null;
  priority: JobPriority;
  require_completion_photo: boolean;
  description: string | null;
  notes_for_technician: string | null;
  created_at: string;
  updated_at: string;
}

interface TechnicianRow {
  id: string;
  name: string;
  country_code: string;
  phone_number: string;
}

interface CustomerProfileRow {
  id: string;
  name: string;
  country_code: string;
  phone_number: string;
  address: string | null;
  city: string | null;
}

interface ActivityLogRow {
  id: string;
  event_type: string;
  actor_id: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

// PostgREST embeds a to-one related resource as an object, but the generated
// types can surface it as an array — normalize both shapes when mapping skills.
interface UserSkillRow {
  tenant_skills: { name: string } | { name: string }[] | null;
}

interface AttachmentRow {
  id: string;
  attachment_type: string;
  r2_key: string;
  created_at: string;
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // UTC+5:30
// Job-detail SELECT as a const + `.single<JobRow>()` — the explicit generic
// types `data`, so the destructure is lint-clean (mirrors getCustomerDetail's
// CUSTOMER_COLUMNS). listJobs keeps an inline literal because its `as JobRow[]`
// cast needs the literal column type.
const JOB_DETAIL_COLUMNS =
  'id, job_number, tenant_id, customer_id, technician_id, service_location, service_type, scheduled_start, scheduled_end, status, current_step, priority, require_completion_photo, description, notes_for_technician, created_at, updated_at';
const PAGE_SIZE = 50;

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);

  constructor(
    private readonly supabaseClientFactory: SupabaseClientFactory,
    private readonly customersService: CustomersService,
    private readonly storageService: StorageService,
  ) {}

  async createJob(owner: RequestUser, dto: CreateJobDto): Promise<JobResponse> {
    // AC #9 — company must be set up (400, not 422).
    if (!owner.tenantId) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Company setup required before creating jobs',
      });
    }

    // AC #6 — exactly one of customerId / newCustomer (422, not 400).
    const hasCustomerId = !!dto.customerId;
    const hasNewCustomer = !!dto.newCustomer;
    if (hasCustomerId === hasNewCustomer) {
      throw new HttpException(
        {
          error_code: ErrorCode.VALIDATION_ERROR,
          message: 'Provide exactly one of customerId or newCustomer',
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // An inverted schedule window is invalid input (422). Both fields are
    // @IsISO8601-validated, so Date.parse never yields NaN here.
    if (
      dto.scheduledEnd &&
      Date.parse(dto.scheduledEnd) < Date.parse(dto.scheduledStart)
    ) {
      throw new HttpException(
        {
          error_code: ErrorCode.VALIDATION_ERROR,
          message: 'scheduledEnd must not be before scheduledStart',
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const admin = this.supabaseClientFactory.createAdmin();

    // Resolve the customer id (link/create via dedup, or validate existing).
    let customerId: string;
    if (dto.newCustomer) {
      const customer = await this.customersService.findOrCreateByPhone(
        owner,
        dto.newCustomer,
      );
      customerId = customer.id;
    } else {
      customerId = dto.customerId as string;
      const { data, error } = await admin
        .from('customers')
        .select('id, tenant_id')
        .eq('id', customerId)
        .eq('tenant_id', owner.tenantId)
        .single<{ id: string; tenant_id: string }>();

      // Guard order matters: genuine DB error → 500 FIRST, then empty → 404.
      // Collapsing into (error || !data) → 404 would mask real DB failures.
      if (error && error.code !== 'PGRST116') {
        this.logger.error('Failed to validate customer:', { error });
        throw new InternalServerErrorException({
          error_code: ErrorCode.INTERNAL_SERVER_ERROR,
          message: 'Failed to validate customer',
        });
      }
      if (!data || data.tenant_id !== owner.tenantId) {
        throw new NotFoundException({
          error_code: ErrorCode.RESOURCE_NOT_FOUND,
          message: 'Customer not found',
        });
      }
    }

    // AC #4 — technician must belong to the tenant and be a technician.
    {
      const { data, error } = await admin
        .from('users')
        .select('id, tenant_id, role')
        .eq('id', dto.technicianId)
        .eq('tenant_id', owner.tenantId)
        .eq('role', 'technician')
        .single<{ id: string; tenant_id: string; role: string }>();

      if (error && error.code !== 'PGRST116') {
        this.logger.error('Failed to validate technician:', { error });
        throw new InternalServerErrorException({
          error_code: ErrorCode.INTERNAL_SERVER_ERROR,
          message: 'Failed to validate technician',
        });
      }
      if (!data || data.tenant_id !== owner.tenantId) {
        throw new NotFoundException({
          error_code: ErrorCode.RESOURCE_NOT_FOUND,
          message: 'Technician not found',
        });
      }
    }

    // Job-number year is the IST creation year (AC #10).
    const istYear = new Date(Date.now() + IST_OFFSET_MS).getUTCFullYear();

    const { data, error } = await admin.rpc('create_job_with_log', {
      p_tenant_id: owner.tenantId,
      p_customer_id: customerId,
      p_technician_id: dto.technicianId,
      p_service_location: dto.serviceLocation,
      p_service_type: dto.serviceType,
      p_scheduled_start: dto.scheduledStart,
      p_scheduled_end: dto.scheduledEnd ?? null,
      p_description: dto.description ?? null,
      p_priority: dto.priority ?? JobPriority.NORMAL,
      p_require_completion_photo: dto.requireCompletionPhoto ?? false,
      p_notes_for_technician: dto.notesForTechnician ?? null,
      p_actor_id: owner.userId,
      p_year: istYear,
    });

    if (error) {
      // A customer/technician deleted between the app-layer validation above and
      // this insert surfaces as a Postgres FK violation (23503). It is a client-
      // resolvable not-found condition, not a server fault — map to 404, not 500.
      const code = (error as { code?: string }).code;
      if (code === '23503') {
        throw new NotFoundException({
          error_code: ErrorCode.RESOURCE_NOT_FOUND,
          message: 'Referenced customer or technician not found',
        });
      }
      this.logger.error('create_job_with_log RPC failed:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to create job',
      });
    }

    // RETURNS SETOF jobs ⇒ supabase-js returns an array.
    const rows = data as JobRow[] | null;
    if (!rows || rows.length === 0) {
      this.logger.error('create_job_with_log returned no rows');
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to create job',
      });
    }

    return this.toResponse(rows[0]);
  }

  async updateJob(
    owner: RequestUser,
    jobId: string,
    dto: UpdateJobDto,
  ): Promise<JobResponse> {
    // AC#10 — company must be set up (400, not 422).
    if (!owner.tenantId) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Company setup required before updating jobs',
      });
    }

    const isCancel = dto.status === JobStatus.CANCELLED;
    const hasEdit = [
      dto.description,
      dto.scheduledStart,
      dto.scheduledEnd,
      dto.notesForTechnician,
      dto.technicianId,
      dto.priority,
    ].some((v) => v !== undefined);

    // AC#14 — cancellation and field edits are mutually exclusive (one log event
    // per request: job_cancelled OR job_reassigned, never an ambiguous mix).
    if (isCancel && hasEdit) {
      throw new HttpException(
        {
          error_code: ErrorCode.VALIDATION_ERROR,
          message: 'Cancellation cannot be combined with field edits',
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // AC#12 — an empty PATCH must not bump updated_at or write a no-op log.
    if (!isCancel && !hasEdit) {
      throw new HttpException(
        {
          error_code: ErrorCode.VALIDATION_ERROR,
          message: 'No updatable fields provided',
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // AC#15 — inverted schedule window (only when BOTH are in the body, mirroring
    // createJob). Both are @IsISO8601-validated, so Date.parse never yields NaN.
    if (
      dto.scheduledStart &&
      dto.scheduledEnd &&
      Date.parse(dto.scheduledEnd) < Date.parse(dto.scheduledStart)
    ) {
      throw new HttpException(
        {
          error_code: ErrorCode.VALIDATION_ERROR,
          message: 'scheduledEnd must not be before scheduledStart',
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const admin = this.supabaseClientFactory.createAdmin();

    // AC#7 — when reassigning, the new technician must belong to the tenant and be
    // a technician. Mirrors createJob's technician validation exactly.
    if (dto.technicianId) {
      const { data, error } = await admin
        .from('users')
        .select('id, tenant_id, role')
        .eq('id', dto.technicianId)
        .eq('tenant_id', owner.tenantId)
        .eq('role', 'technician')
        .single<{ id: string; tenant_id: string; role: string }>();

      if (error && error.code !== 'PGRST116') {
        this.logger.error('Failed to validate technician:', { error });
        throw new InternalServerErrorException({
          error_code: ErrorCode.INTERNAL_SERVER_ERROR,
          message: 'Failed to validate technician',
        });
      }
      if (!data || data.tenant_id !== owner.tenantId) {
        throw new NotFoundException({
          error_code: ErrorCode.RESOURCE_NOT_FOUND,
          message: 'Technician not found',
        });
      }
    }

    // Atomic edit/reassign/cancel + activity log (AR-10). The scheduled-only guard
    // lives inside the RPC (SELECT … FOR UPDATE) to be TOCTOU-safe; updated_at is
    // set explicitly there (no DB trigger). A null param leaves the column as-is.
    const { data, error } = await admin.rpc('update_job_with_log', {
      p_job_id: jobId,
      p_tenant_id: owner.tenantId,
      p_actor_id: owner.userId,
      p_cancel: isCancel,
      p_description: dto.description ?? null,
      p_scheduled_start: dto.scheduledStart ?? null,
      p_scheduled_end: dto.scheduledEnd ?? null,
      p_notes_for_technician: dto.notesForTechnician ?? null,
      p_technician_id: dto.technicianId ?? null,
      p_priority: dto.priority ?? null,
    });

    if (error) {
      const code = (error as { code?: string }).code;
      // The RPC raises SQLSTATE PT409 for a non-scheduled job (verified live via
      // Supabase MCP). PostgREST surfaces the SQLSTATE as error.code → map to 409.
      if (code === 'PT409') {
        throw new HttpException(
          {
            error_code: ErrorCode.JOB_NOT_MODIFIABLE,
            message: 'Job is not modifiable in its current status',
          },
          HttpStatus.CONFLICT,
        );
      }
      // The RPC raises PT422 when the EFFECTIVE schedule window is inverted —
      // i.e. a one-sided edit (only start or only end) pushes the stored window
      // past the unchanged bound, which the both-present app check can't catch.
      if (code === 'PT422') {
        throw new HttpException(
          {
            error_code: ErrorCode.VALIDATION_ERROR,
            message: 'scheduledEnd must not be before scheduledStart',
          },
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      // A technician deleted between validation and the RPC surfaces as a Postgres
      // FK violation (23503) — a client-resolvable not-found, not a server fault.
      if (code === '23503') {
        throw new NotFoundException({
          error_code: ErrorCode.RESOURCE_NOT_FOUND,
          message: 'Referenced technician not found',
        });
      }
      this.logger.error('update_job_with_log RPC failed:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to update job',
      });
    }

    // RETURNS SETOF jobs ⇒ an empty array means the tenant-scoped row was not found
    // (missing or cross-tenant) → 404, never disclosed as 403 (AC#8).
    const rows = data as JobRow[] | null;
    if (!rows || rows.length === 0) {
      throw new NotFoundException({
        error_code: ErrorCode.RESOURCE_NOT_FOUND,
        message: 'Job not found',
      });
    }

    return this.toResponse(rows[0]);
  }

  async listJobs(
    user: RequestUser,
    query: ListJobsQueryDto,
  ): Promise<PaginatedResponse<JobResponse>> {
    // AC #11 — company must be set up (400, not 422).
    if (!user.tenantId) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Company setup required before listing jobs',
      });
    }

    // AC #1 / #3 — the IST day window. For an explicit date, anchor on noon IST
    // (06:30Z) so the instant is unambiguously inside that calendar day; default
    // to the current IST day. Reuses getIstDayRange — no new util.
    const range = query.date
      ? getIstDayRange(new Date(`${query.date}T06:30:00.000Z`))
      : getIstDayRange();

    const admin = this.supabaseClientFactory.createAdmin();

    let qb = admin
      .from('jobs')
      // prettier-ignore — single string literal so postgrest-js infers JobRow columns
      .select(
        'id, job_number, tenant_id, customer_id, technician_id, service_location, service_type, scheduled_start, scheduled_end, status, current_step, priority, require_completion_photo, description, notes_for_technician, created_at, updated_at',
      )
      .eq('tenant_id', user.tenantId)
      .gte('scheduled_start', range.start.toISOString())
      .lt('scheduled_start', range.end.toISOString());

    // AC #2 — repeatable status filter.
    if (query.status?.length) {
      qb = qb.in('status', query.status);
    }

    // AC #4 / #5 — technician scoping. Technicians see ONLY their own jobs; the
    // technicianId query param is silently ignored for them. Owners may filter.
    if (user.role === Role.TECHNICIAN) {
      qb = qb.eq('technician_id', user.userId);
    } else if (query.technicianId) {
      qb = qb.eq('technician_id', query.technicianId);
    }

    // AC #7 / #8 — keyset cursor under (created_at DESC, id DESC). decodeCursor
    // throws 400 on a malformed cursor.
    if (query.cursor) {
      const c = decodeCursor(query.cursor);
      qb = qb.or(
        `created_at.lt.${c.createdAt},and(created_at.eq.${c.createdAt},id.lt.${c.id})`,
      );
    }

    const { data, error } = await qb
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(PAGE_SIZE + 1);

    if (error) {
      this.logger.error('Failed to list jobs:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to list jobs',
      });
    }

    const rows = (data ?? []) as JobRow[];
    const hasMore = rows.length > PAGE_SIZE;
    const pageRows = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
    const last = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && last ? encodeCursor(last.id, last.created_at) : null;

    return new PaginatedResponse(
      pageRows.map((row) => this.toResponse(row)),
      nextCursor,
    );
  }

  async getJobDetail(
    user: RequestUser,
    jobId: string,
  ): Promise<JobDetailResponse> {
    // AC#8 — company must be set up (400, not 422).
    if (!user.tenantId) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Company setup required before viewing jobs',
      });
    }

    const admin = this.supabaseClientFactory.createAdmin();

    // 1) Fetch + tenant gate. The explicit tenant_id filter is defense-in-depth
    //    (createAdmin bypasses RLS). A real DB error → 500 FIRST; PGRST116 /
    //    empty / cross-tenant → 404 (AC#2, AC#3) — never 403.
    const { data: row, error } = await admin
      .from('jobs')
      .select(JOB_DETAIL_COLUMNS)
      .eq('id', jobId)
      .eq('tenant_id', user.tenantId)
      .single<JobRow>();

    if (error && error.code !== 'PGRST116') {
      this.logger.error('Failed to fetch job:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to fetch job',
      });
    }
    if (!row || row.tenant_id !== user.tenantId) {
      throw new NotFoundException({
        error_code: ErrorCode.RESOURCE_NOT_FOUND,
        message: 'Job not found',
      });
    }

    // 2) Ownership gate — a technician may only view jobs assigned to them
    //    (AC#4). Resolved AFTER the 404 so a cross-tenant job is never 403.
    if (user.role === Role.TECHNICIAN && row.technician_id !== user.userId) {
      throw new ForbiddenException({
        error_code: ErrorCode.FORBIDDEN,
        message: 'Forbidden',
      });
    }

    // 3) Assemble related records in parallel — reads need no atomicity (AR-10
    //    governs writes). technician_id / customer_id are NOT NULL FKs, so the
    //    rows always exist; a missing row is a server fault (500), not a 404.
    const [techRes, skillRes, custRes, logRes, attachRes] = await Promise.all([
      admin
        .from('users')
        .select('id, name, country_code, phone_number')
        .eq('id', row.technician_id)
        .eq('tenant_id', user.tenantId)
        .single<TechnicianRow>(),
      admin
        .from('user_skills')
        // Defense-in-depth tenant scope. user_skills has no tenant_id column
        // (PK is user_id, skill_id), so constrain via the embedded tenant_skills
        // — `!inner` drops any row whose skill belongs to another tenant. The
        // technician is already tenant-verified above, but createAdmin() bypasses
        // RLS so this app-layer filter keeps the read consistent with the others.
        .select('tenant_skills!inner(name)')
        .eq('user_id', row.technician_id)
        .eq('tenant_skills.tenant_id', user.tenantId),
      admin
        .from('customers')
        .select('id, name, country_code, phone_number, address, city')
        .eq('id', row.customer_id)
        .eq('tenant_id', user.tenantId)
        .single<CustomerProfileRow>(),
      admin
        .from('activity_logs')
        .select('id, event_type, actor_id, metadata, created_at')
        .eq('job_id', jobId)
        .eq('tenant_id', user.tenantId)
        .order('created_at', { ascending: true }),
      admin
        .from('attachments')
        .select('id, attachment_type, r2_key, created_at')
        .eq('job_id', jobId)
        .eq('tenant_id', user.tenantId)
        .order('created_at', { ascending: true }),
    ]);

    // A 0-row `.single()` on technician/customer returns `error.code ===
    // 'PGRST116'` (not data:null), so exclude it here and let the missing-row
    // branch below handle it — otherwise the ID-naming diagnostic log never
    // fires. Any other error on any of the four reads is a genuine fault → 500.
    const realError =
      (techRes.error && techRes.error.code !== 'PGRST116') ||
      (custRes.error && custRes.error.code !== 'PGRST116') ||
      skillRes.error ||
      logRes.error ||
      attachRes.error;
    if (realError) {
      this.logger.error('Failed to assemble job detail:', {
        technician: techRes.error,
        skills: skillRes.error,
        customer: custRes.error,
        activityLog: logRes.error,
        attachments: attachRes.error,
      });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to fetch job',
      });
    }
    if (!techRes.data || !custRes.data) {
      this.logger.error('Job references a missing technician or customer', {
        jobId,
        technicianId: row.technician_id,
        customerId: row.customer_id,
      });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to fetch job',
      });
    }

    const skillRows = (skillRes.data ?? []) as UserSkillRow[];
    const skills = skillRows
      .flatMap((r) => {
        const ts = r.tenant_skills;
        if (Array.isArray(ts)) return ts.map((t) => t.name);
        return ts ? [ts.name] : [];
      })
      // Guard against a null/empty name slipping through either embed shape.
      .filter((name): name is string => Boolean(name));

    const activityLog = ((logRes.data ?? []) as ActivityLogRow[]).map((l) => ({
      id: l.id,
      eventType: l.event_type,
      actorId: l.actor_id,
      metadata: l.metadata,
      createdAt: l.created_at,
    }));

    const attachmentRows = (attachRes.data ?? []) as AttachmentRow[];
    // Sign each read URL in isolation: a transient storage-signing failure
    // degrades that one attachment's url to null rather than 500-ing the whole
    // job detail (the DB reads already succeeded).
    const attachments: JobAttachmentResponse[] = await Promise.all(
      attachmentRows.map(async (a) => {
        let url: string | null = null;
        try {
          url = await this.storageService.getPresignedReadUrl(
            a.r2_key,
            ATTACHMENT_READ_URL_TTL_SECONDS,
          );
        } catch (err) {
          this.logger.error('Failed to sign attachment read URL', {
            attachmentId: a.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return {
          id: a.id,
          type: a.attachment_type,
          url,
          createdAt: a.created_at,
        };
      }),
    );

    return this.toDetailResponse(
      row,
      techRes.data,
      skills,
      custRes.data,
      activityLog,
      attachments,
    );
  }

  private toDetailResponse(
    row: JobRow,
    technician: TechnicianRow,
    skills: string[],
    customer: CustomerProfileRow,
    activityLog: ActivityLogEntry[],
    attachments: JobAttachmentResponse[],
  ): JobDetailResponse {
    return {
      ...this.toResponse(row),
      technician: {
        id: technician.id,
        name: technician.name,
        countryCode: technician.country_code,
        phoneNumber: technician.phone_number,
        skills,
      },
      customer: {
        id: customer.id,
        name: customer.name,
        countryCode: customer.country_code,
        phoneNumber: customer.phone_number,
        address: customer.address,
        city: customer.city,
      },
      activityLog,
      attachments,
    };
  }

  // Public so WorkflowService (same module) can reuse the snake→camel mapping
  // without re-deriving it (Story 3.5).
  toResponse(row: JobRow): JobResponse {
    return {
      id: row.id,
      jobNumber: row.job_number,
      tenantId: row.tenant_id,
      customerId: row.customer_id,
      technicianId: row.technician_id,
      serviceLocation: row.service_location,
      serviceType: row.service_type,
      scheduledStart: row.scheduled_start,
      scheduledEnd: row.scheduled_end,
      status: row.status,
      currentStep: row.current_step,
      priority: row.priority,
      requireCompletionPhoto: row.require_completion_photo,
      description: row.description,
      notesForTechnician: row.notes_for_technician,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
