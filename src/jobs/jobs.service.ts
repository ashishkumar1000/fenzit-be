import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { PgPoolFactory } from '../common/pg/pg-pool.factory';
import { readSubtreeMemberIds } from '../common/members/hierarchy';
import { readScopeFor } from '../common/permissions/permissions';
import { ErrorCode } from '../common/enums/error-code.enum';
import { Role } from '../common/enums/role.enum';
import { findCompanyMember } from '../common/members/company-members';
import {
  avatarUrlFor,
  presignAvatarUrls,
} from '../common/members/member-avatars';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { PaginatedResponse } from '../common/dto/paginated-response.dto';
import {
  ADMIN_ROLE,
  approverRecipients,
  decisionFor,
  loadApprovalTree,
  mayDecide,
  resolveApprovers,
  resolveApproversWithTree,
  type ApproverSet,
  type DecisionView,
} from '../attendance/approval-routing';
import { lockTenantShared } from '../attendance/enrolments.repository';
import {
  encodeCursor,
  decodeCursor,
  CursorScope,
} from '../common/utils/cursor.util';
import { getIstDayRange } from '../common/utils/ist-day-range.util';
import { CustomersService } from '../customers/customers.service';
import { StorageService } from '../storage/storage.service';
import { CreateJobDto } from './dto/create-job.dto';
import { UpdateJobDto } from './dto/update-job.dto';
import { DecidePendingJobDto } from './dto/decide-pending-job.dto';
import { ListJobsQueryDto } from './dto/list-jobs-query.dto';
import { JobsPageQueryDto } from './dto/jobs-page-query.dto';
import { insertJobAssignedNotification } from './job-notifications';
import {
  editLockedForOwner,
  isEmployeeCreator,
  alertCreatorOfCancel,
  alertCreatorOfDecision,
  alertCreatorOfEdit,
  alertApproversOfSubmission,
  changedEditFields,
  type JobBeforeUpdate,
} from './pending-job-notifications';
import { resolveEmployeeSubmission } from './employee-submission';
import { JobListScope } from './enums/job-list-scope.enum';
import { JobStatus } from './enums/job-status.enum';
import { JobPriority } from './enums/job-priority.enum';
import {
  parseTemplateSteps,
  stepToResponse,
  currentStepIndexForRead,
  normalizeSkillEmbed,
  WorkflowTemplateResponse,
} from './workflow-template.model';

// TTL for presigned R2 read URLs surfaced in job detail. Regenerated fresh on
// every getJobDetail call, never stored (AC#18).
const ATTACHMENT_READ_URL_TTL_SECONDS = 3600; // 1 hour

/** The job's stamped skill, as exposed on every job response (Story 4.5). */
export interface JobSkillResponse {
  id: string;
  name: string;
}

// WorkflowTemplateResponse lives in workflow-template.model.ts (shared with the
// sync DTO); re-exported here for existing consumers of the jobs module.
export type { WorkflowTemplateResponse };

export interface JobResponse {
  id: string;
  jobNumber: string;
  tenantId: string;
  customerId: string;
  technicianId: string;
  serviceLocation: string;
  scheduledStart: string;
  scheduledEnd: string | null;
  status: JobStatus;
  // When the job actually completed — null until the advance_workflow_step RPC
  // stamps it (or for rows created before the column existed). Cancelled jobs
  // never get one.
  completedAt: string | null;
  currentStep: string | null;
  priority: JobPriority;
  description: string | null;
  notesForTechnician: string | null;
  // Epic 22 — who created the job (creator = owner for owner-created jobs,
  // the employee for employee-created ones) and, for a decided pending job,
  // when it was decided and why it was rejected. Clients show the rejection
  // reason on the job itself; it is never a secret within the job's audience.
  createdBy: string | null;
  decidedAt: string | null;
  rejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
  // Story 4.5 — the job's skill (id + display name) and stamped template ride
  // every job response via FK embeds. Both are null-safe on the READ path: a
  // missing/unreadable embed (unreachable under the FK + no-delete posture)
  // maps to null rather than failing the read — only the advance path guards
  // corrupt template data strictly (422/500). Inactive skills still render:
  // the label is historical, so job embeds never filter is_active.
  skill: JobSkillResponse | null;
  workflowTemplate: WorkflowTemplateResponse | null;
  // Epic 23 review — the assignee's id and name on every job response, so the
  // owner can see who a job belongs to from the list without opening it.
  // Null-safe like skill: an unreadable embed maps to null, never drops the row.
  technician: { id: string; name: string | null } | null;
  // Epic 23 enrichment — the customer's id and name on every job response, so
  // a jobs list can show for WHOM the work is (the approval queue already
  // carries the name; the list now matches). Null-safe like technician.
  customer: { id: string; name: string | null } | null;
  // 0-based index of current_step in the stamped template's steps. Null while
  // the job is fresh (no advance yet) and when the template data is unreadable.
  currentStepIndex: number | null;
  /**
   * 24-5/CAP-5 — "can I decide this job?". Present on list and detail reads;
   * absent on write responses (the app re-reads). Answered by the same walk
   * the decision POST runs, on the CREATOR's branch, so a manager above the
   * resolved approver gets `false` + a reason instead of a client-side walk.
   */
  decision?: DecisionView;
}

/** A technician/customer profile embedded in the job-detail response. */
interface TechnicianProfile {
  id: string;
  name: string;
  countryCode: string;
  phoneNumber: string;
  skills: string[];
  /** Short-lived link to the technician's photo, or null when none is set. */
  avatarUrl: string | null;
}

interface CustomerProfile {
  id: string;
  name: string;
  countryCode: string;
  phoneNumber: string;
  address: string | null;
  city: string | null;
  // Saved geocoordinates from Epic 1's structured-address persistence (null when
  // the customer was created without them or predates Story 1.3).
  latitude: number | null;
  longitude: number | null;
  // CAP-5 — user-entered extra location detail (flat/building/floor/landmark)
  // for the final handoff; null when the customer has none.
  addressDetails: string | null;
  // The resolved Places line (null on free-text/manual customers). Carried so
  // clients can show the geocoded address even when the free-text `address`
  // holds only the user's own street/landmark notes (design v2).
  formattedAddress: string | null;
}

/** One activity-log entry as returned by the job-detail endpoint. */
export interface ActivityLogEntry {
  id: string;
  eventType: string;
  actorId: string;
  // CAP-6 — the actor's display name, resolved here so the creator (an employee
  // holding only job.read_own) can see who acted without any member.read call.
  actorName: string | null;
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
  scheduled_start: string;
  scheduled_end: string | null;
  status: JobStatus;
  completed_at: string | null;
  current_step: string | null;
  priority: JobPriority;
  description: string | null;
  notes_for_technician: string | null;
  // Epic 22 — creator and decision fields on every job read (additive). All
  // nullable: owner-created jobs predate created_by stamps, and undecided
  // jobs have no decision. Rejection reason rides the row so the creator can
  // read it on the job itself, not only via notifications/reports.
  created_by: string | null;
  decided_at: string | null;
  rejection_reason: string | null;
  created_at: string;
  updated_at: string;
  // NOT NULL under the FK (the create RPC stamps it) — typed nullable to keep
  // the read mapping soft. Consumed via the `skills` embed, not directly.
  skill_id: string | null;
  // Story 4.5 — FK embeds selected alongside every job read. PostgREST embeds
  // a to-one related resource as an object but can surface it as an array, so
  // both shapes are normalized when mapping (mirrors UserSkillRow below).
  skills: { id: string; name: string } | { id: string; name: string }[] | null;
  workflow_templates: { version: number; steps: unknown } | null;
}

/**
 * One row of the jobs_overview view (the paged console list's flattened read
 * model, 20261120000000) — the joined names ride along as bare columns so the
 * page endpoint can search and sort by them. Typed leniently on every joined
 * column: the view left-joins, so a missing counterpart maps to null without
 * dropping the row (the same read-leniency contract as toResponse).
 */
interface JobsOverviewRow {
  id: string;
  job_number: string;
  tenant_id: string;
  customer_id: string;
  technician_id: string | null;
  service_location: string;
  scheduled_start: string | null;
  scheduled_end: string | null;
  status: JobStatus;
  priority: JobPriority;
  description: string | null;
  completed_at: string | null;
  current_step: string | null;
  skill_id: string | null;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
  rejection_reason: string | null;
  customer_name: string | null;
  technician_name: string | null;
  skill_name: string | null;
  template_version: number | null;
  template_steps: unknown;
}

/** Whole-company counters for the console's job stat tiles and status chips —
 *  counted before any filter, so they stay stable while the table narrows
 *  (the members/customers stats contract). One counter per status keeps every
 *  chip's count honest; completed30d feeds the tile. */
export interface JobsStats {
  total: number;
  scheduled: number;
  inProgress: number;
  pendingApproval: number;
  completed: number;
  cancelled: number;
  rejected: number;
  /** Jobs whose completed_at falls in the last 30 days. */
  completed30d: number;
}

/** One row of the console's paged jobs table — the lean shape the web reads (mirrors the FE JobRow: no tenant ids, no notes, no embeds beyond the names). */
export interface JobPageItem {
  id: string;
  jobNumber: string;
  status: JobStatus;
  priority: JobPriority;
  scheduledStart: string | null;
  currentStep: string | null;
  skill: { id: string; name: string } | null;
  technician: { id: string; name: string | null } | null;
  customer: { id: string; name: string | null } | null;
  description: string | null;
  serviceLocation: string;
  completedAt: string | null;
  createdAt: string;
  decidedAt: string | null;
  rejectionReason: string | null;
  /** 0-based position of current_step in the stamped template; null on a fresh job. */
  currentStepIndex: number | null;
  workflowTemplate: WorkflowTemplateResponse | null;
}

/** GET /jobs/page response: one page + the filtered exact total + whole-company stats. */
export interface JobsPage {
  data: JobPageItem[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
  stats: JobsStats;
}

interface TechnicianRow {
  id: string;
  name: string;
  country_code: string;
  phone_number: string;
  avatar_key: string | null;
}

interface CustomerProfileRow {
  id: string;
  name: string;
  country_code: string;
  phone_number: string;
  address: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  address_details: string | null;
  formatted_address: string | null;
}

interface ActivityLogRow {
  id: string;
  event_type: string;
  actor_id: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
  // CAP-6 — the actor's name rides the same read via the users FK embed.
  // PostgREST can surface a to-one embed as an object or an array; normalize.
  users: { name: string | null } | { name: string | null }[] | null;
}

/** The one name inside a to-one users embed, in either PostgREST shape. */
function embedUserName(embed: ActivityLogRow['users']): string | null {
  const one = Array.isArray(embed) ? (embed[0] ?? null) : (embed ?? null);
  return typeof one?.name === 'string' ? one.name : null;
}

// PostgREST embeds a to-one related resource as an object, but the generated
// types can surface it as an array — normalize both shapes when mapping skills.
interface UserSkillRow {
  skills: { name: string } | { name: string }[] | null;
}

interface AttachmentRow {
  id: string;
  attachment_type: string;
  r2_key: string;
  created_at: string;
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // UTC+5:30
// The canonical job SELECT — every producer of JobRow/JobResponse (detail,
// list, create/update re-fetch, workflow replay, profile jobs) shares it, so
// the skill/template embeds can never drift out of one response shape (Story
// 4.5). Plain left embeds, NOT !inner: a hypothetical missing skill row must
// degrade to null response fields, never silently drop the job row.
// Exported so sibling services reuse the same literal.
export const JOB_COLUMNS =
  'id, job_number, tenant_id, customer_id, technician_id, service_location, scheduled_start, scheduled_end, status, completed_at, current_step, priority, description, notes_for_technician, created_by, decided_at, rejection_reason, created_at, updated_at, skill_id, skills(id, name), technician:users!jobs_technician_id_fkey(id, name), customer:customers!jobs_customer_id_fkey(id, name), workflow_templates(version, steps)';
const PAGE_SIZE = 50;
// Cursor scope per timeline scope (Story 3.7): a cursor minted for one scope is
// rejected (400) when replayed against another — jobs-list keys on created_at,
// the timeline scopes key on scheduled_start, and their sort directions differ.
// The today scope's 'jobs-list' tag keeps existing today-cursors valid; a
// cursor minted for another paginated endpoint is still rejected (400) here.
const JOBS_CURSOR_SCOPE_BY_SCOPE: Record<JobListScope, CursorScope> = {
  [JobListScope.TODAY]: 'jobs-list',
  [JobListScope.UPCOMING]: 'jobs-upcoming',
  [JobListScope.OVERDUE]: 'jobs-overdue',
  [JobListScope.HISTORY]: 'jobs-history',
  // `all` sorts on created_at DESC exactly like today, so it shares the
  // 'jobs-list' cursor tag — a cursor minted by either replays fine on the
  // other (same column, same direction).
  [JobListScope.ALL]: 'jobs-list',
};

/**
 * A job cannot start before today (IST day). Earlier today is still allowed.
 * Shared by create and reschedule so both refuse the same starts.
 */
function assertStartNotInPast(scheduledStart: string): void {
  if (Date.parse(scheduledStart) < getIstDayRange().start.getTime()) {
    throw new HttpException(
      {
        error_code: ErrorCode.VALIDATION_ERROR,
        message:
          'scheduledStart cannot be in the past. Pick today or a later day.',
      },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);

  constructor(
    private readonly supabaseClientFactory: SupabaseClientFactory,
    private readonly customersService: CustomersService,
    private readonly storageService: StorageService,
    private readonly pg: PgPoolFactory,
  ) {}

  /**
   * A manager-employee's read scope: self plus their reporting subtree
   * (24-2/CAP-2). Null for everyone else and for an employee without
   * reports, so those callers keep today's behaviour exactly. Viewers are
   * deliberately not scoped here: `job.read_all` already covers the company.
   */
  /**
   * 24-5/CAP-5 — one decision answer per job row. The walk runs on the
   * CREATOR's branch (a pending job routes from whoever submitted it), and
   * the admin override is read from the live tree, exactly as
   * `decidePendingJob` does it — so a button shown here can never disagree
   * with the POST. A row with no creator is visible but nobody but an admin
   * can decide it (`unresolved`).
   */
  private async readJobDecisions(
    tenantId: string,
    rows: { id: string; status: JobStatus; createdBy: string | null }[],
    callerId: string,
  ): Promise<Map<string, DecisionView>> {
    const decisions = new Map<string, DecisionView>();
    for (const row of rows) {
      if (row.status !== JobStatus.PENDING_APPROVAL) {
        decisions.set(row.id, { canDecide: false, reason: 'not_pending' });
      }
    }
    const pending = rows.filter(
      (row) => row.status === JobStatus.PENDING_APPROVAL,
    );
    if (pending.length === 0) return decisions;

    try {
      return await this.pg.withTransaction(async (tx) => {
        const tree = await loadApprovalTree(tx, tenantId);
        const caller = tree.get(callerId.toLowerCase());
        const callerIsAdmin =
          caller !== undefined &&
          caller.status === 'active' &&
          !caller.disabled &&
          caller.role === ADMIN_ROLE;
        const sets = new Map<string, ApproverSet>();
        for (const row of pending) {
          if (!row.createdBy) {
            decisions.set(row.id, { canDecide: false, reason: 'unresolved' });
            continue;
          }
          let set = sets.get(row.createdBy);
          if (!set) {
            set = resolveApproversWithTree(tree, row.createdBy, row.createdBy);
            sets.set(row.createdBy, set);
          }
          decisions.set(
            row.id,
            decisionFor(set, callerId, callerIsAdmin, true),
          );
        }
        return decisions;
      });
    } catch (error) {
      this.logger.warn('Failed to read the reporting tree for job decisions', {
        error,
        tenantId,
      });
      for (const row of pending) {
        decisions.set(row.id, { canDecide: false, reason: 'unresolved' });
      }
      return decisions;
    }
  }

  private async teamScope(user: RequestUser): Promise<Set<string> | null> {
    // The shared scope decision: a role that already reads the whole company
    // (admin, platform, viewer's job.read_all) is never narrowed (D13).
    if (!user.tenantId) return null;
    if (readScopeFor(user.role, 'job.read_all') === 'tenant') return null;
    const tenantId = user.tenantId;
    return this.pg.withTransaction(async (tx) => {
      const ids = await readSubtreeMemberIds(tx, tenantId, user.userId);
      if (ids.length === 0) return null;
      return new Set([user.userId, ...ids]);
    });
  }

  /**
   * 24-4: the resolved submission set and the `job_submitted` audit snapshot.
   * Read under the shared tenant lock so a concurrent tree write cannot land
   * between the walk and the snapshot write.
   */
  private routeJobSubmission(
    tenantId: string,
    jobId: string,
    creatorId: string,
  ): Promise<{ set: ApproverSet; recipients: string[] }> {
    return this.pg.withTransaction(async (tx) => {
      await lockTenantShared(tx, tenantId);
      const set = await resolveApprovers(tx, tenantId, creatorId, creatorId);
      const recipients = approverRecipients(set);
      let alertRecipients = recipients;
      if (recipients.length > 0) {
        // The create RPC wrote this row moments ago in the same request.
        // Tenant-scoped and counted: a missing row must not leave the audit
        // answer silently blank.
        const updated = await tx.query(
          `update public.activity_logs set resolved_approvers = $2::uuid[]
            where job_id = $1::uuid and tenant_id = $3::uuid
              and event_type = 'job_submitted'`,
          [jobId, recipients, tenantId],
        );
        if (updated.rowCount === 0) {
          this.logger.warn('Approver snapshot found no job_submitted row', {
            tenantId,
            jobId,
          });
        }
        // A tree write can commit between the create RPC and this lock. That
        // write already announced the new approver; do not ring the same bell
        // twice for one submission.
        const announced = await tx.query<{ user_id: string }>(
          `select distinct user_id from public.notifications
            where job_id = $1::uuid and event_type = 'job.approver_added'`,
          [jobId],
        );
        const alreadyTold = new Set(announced.rows.map((row) => row.user_id));
        alertRecipients = recipients.filter((id) => !alreadyTold.has(id));
      }
      return { set, recipients: alertRecipients };
    });
  }

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

    // CAP-2/3/4 — an employee's own job. Refused before any customer is written.
    // Owners get null: their jobs are never pending.
    const submission = await resolveEmployeeSubmission(
      admin,
      owner,
      dto.technicianId,
    );

    // Past-start check comes after the permission check, so a caller who may not
    // create the job gets 403, not a date error. Still before any customer or
    // job is written.
    assertStartNotInPast(dto.scheduledStart);

    // Resolve the customer id (link/create via dedup, or validate existing).
    // The new-customer path hands back the full row, so the assignment
    // notification's payload can carry the name without re-reading.
    let knownCustomerName: string | null = null;
    let customerId: string;
    if (dto.newCustomer) {
      const customer = await this.customersService.findOrCreateByPhone(
        owner,
        dto.newCustomer,
      );
      customerId = customer.id;
      knownCustomerName = customer.name ?? null;
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
      let employee: Awaited<ReturnType<typeof findCompanyMember>>;
      try {
        employee = await findCompanyMember(
          admin,
          owner.tenantId,
          dto.technicianId,
          { role: Role.EMPLOYEE },
        );
      } catch (error) {
        this.logger.error('Failed to validate technician:', { error });
        throw new InternalServerErrorException({
          error_code: ErrorCode.INTERNAL_SERVER_ERROR,
          message: 'Failed to validate technician',
        });
      }
      if (!employee) {
        throw new NotFoundException({
          error_code: ErrorCode.RESOURCE_NOT_FOUND,
          message: 'Technician not found',
        });
      }
      // Parked access: a deactivated member keeps their records but cannot be
      // handed new work (the enrolments guard's shape — honest 409, never the
      // misleading 404 the removed-only filter would miss).
      if (employee.status === 'deactivated') {
        throw new ConflictException({
          error_code: ErrorCode.MEMBERSHIP_STATE,
          message:
            'This member is deactivated — reinstate them before assigning them a job',
        });
      }
    }

    // Story 4.3 — skillId must exist in the global skills catalog and be
    // active. Invite-precedent pattern (auth.service.ts): the skills table is
    // platform-wide (no tenant scoping); the create RPC stamps the skill's
    // latest workflow template, so an inactive/unknown skill must be rejected
    // here — 400 before the RPC (DTO @IsUUID already rejects shape violations
    // with 422).
    {
      const { data, error } = await admin
        .from('skills')
        .select('id')
        .eq('id', dto.skillId)
        .eq('is_active', true)
        .maybeSingle<{ id: string }>();

      if (error) {
        this.logger.error('Failed to validate skill ID:', { error });
        throw new InternalServerErrorException({
          error_code: ErrorCode.INTERNAL_SERVER_ERROR,
          message: 'Failed to validate skill ID',
        });
      }
      if (!data) {
        throw new BadRequestException({
          error_code: ErrorCode.VALIDATION_ERROR,
          message: 'Unknown or inactive skillId',
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
      p_skill_id: dto.skillId,
      p_scheduled_start: dto.scheduledStart,
      p_scheduled_end: dto.scheduledEnd ?? null,
      p_description: dto.description ?? null,
      p_priority: dto.priority ?? JobPriority.NORMAL,
      p_notes_for_technician: dto.notesForTechnician ?? null,
      p_actor_id: owner.userId,
      p_year: istYear,
      p_created_by: owner.userId,
      p_pending_approval: submission?.pendingApproval ?? false,
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

    // Pending-approval submission (24-4/CAP-4): the resolved approver set
    // hears about it, not all admins. Written after the RPC commits;
    // log-and-drop, so it never fails the create.
    if (rows[0].status === JobStatus.PENDING_APPROVAL) {
      const creatorId = rows[0].created_by ?? owner.userId;
      // The create RPC has already committed. A failure in this best-effort
      // routing pass must never turn a successful create into a 500 — the
      // client would retry and submit a duplicate while the first job sits
      // invisibly in the approval queue.
      let routing: { set: ApproverSet; recipients: string[] } | null = null;
      // One retry: a lock timeout behind a bulk re-parent is transient, and the
      // walk + snapshot write are idempotent. A second failure only logs.
      for (let attempt = 0; attempt < 2 && routing === null; attempt += 1) {
        try {
          routing = await this.routeJobSubmission(
            owner.tenantId,
            rows[0].id,
            creatorId,
          );
        } catch (error: unknown) {
          if (attempt === 1) {
            this.logger.error(
              'Job routing lost after create; the job stays pending with no submission alert',
              { tenantId: owner.tenantId, jobId: rows[0].id, error },
            );
          }
        }
      }
      if (routing?.set.kind === 'unresolved') {
        this.logger.warn('Job routing could not resolve an approver', {
          tenantId: owner.tenantId,
          jobId: rows[0].id,
          reason: routing.set.reason,
        });
      } else if (routing && routing.recipients.length > 0) {
        void alertApproversOfSubmission(
          admin,
          rows[0],
          routing.recipients,
          creatorId,
        );
      }
    }

    // Job assignment is a notification (user decision 2026-11-07): the new
    // technician hears about the job through the bell (and, with push live,
    // the OS). Skip when the acting user IS the technician (assigning work
    // to yourself must not ring your own bell); the helper is log-and-drop,
    // so a failed insert never fails the job write or this response.
    if (rows[0].technician_id !== owner.userId) {
      await insertJobAssignedNotification(
        admin,
        rows[0],
        rows[0].technician_id,
        knownCustomerName,
      );
    }

    return this.toResponse(
      // The RPC returns bare job rows; re-fetch with the skill/template embeds
      // so the create response carries the full read shape (Story 4.5).
      await this.refetchWithEmbeds(admin, rows[0].id, owner.tenantId, rows[0]),
    );
  }

  /**
   * 24-4 — the resolved approver (or any active admin) approves or rejects a
   * pending employee job. The walk and the write share one transaction under
   * the shared tenant lock; the guarded UPDATE makes exactly one decision win
   * a race. The endpoint contract is unchanged from the retired RPC path.
   */
  async decidePendingJob(
    owner: RequestUser,
    jobId: string,
    dto: DecidePendingJobDto,
  ): Promise<JobResponse> {
    if (!owner.tenantId) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Company setup required before deciding jobs',
      });
    }
    const tenantId = owner.tenantId;
    const admin = this.supabaseClientFactory.createAdmin();
    // One trim, shared by the write and the alert below. A reason that is all
    // whitespace is no reason at all (the RPC's btrim semantics).
    const reason = dto.reason?.trim() || null;

    const decided = await this.pg.withTransaction(async (tx) => {
      await lockTenantShared(tx, tenantId);
      const found = await tx.query<JobRow>(
        `select * from public.jobs
          where id = $1 and tenant_id = $2
          for update`,
        [jobId, tenantId],
      );
      const job = found.rows[0];
      if (!job) {
        throw new NotFoundException({
          error_code: ErrorCode.RESOURCE_NOT_FOUND,
          message: 'Job not found',
        });
      }
      if (job.status !== JobStatus.PENDING_APPROVAL) {
        throw new ConflictException({
          error_code: ErrorCode.JOB_NOT_PENDING,
          message: 'This job has already been approved or rejected',
        });
      }

      // The override right is decided from the LIVE tree read inside this
      // transaction, never from the role on the token: the guard read the
      // caller's membership before the tenant lock, so a demotion/deactivation
      // that committed while we waited must not leave a stale admin deciding
      // one more job.
      const tree = await loadApprovalTree(tx, tenantId);
      const caller = tree.get(owner.userId.toLowerCase());
      const callerIsAdmin =
        caller !== undefined &&
        caller.status === 'active' &&
        !caller.disabled &&
        caller.role === ADMIN_ROLE;

      if (!callerIsAdmin) {
        if (!job.created_by) {
          throw new ConflictException({
            error_code: ErrorCode.APPROVER_UNRESOLVED,
            message:
              'This job has no creator on file, so it cannot be routed — an admin must decide it',
          });
        }
        // 24-4/CAP-3: the creator is both requester and actor — an
        // owner-created job is never pending, and job on-behalf does not exist
        // in this epic.
        const approvers = resolveApproversWithTree(
          tree,
          job.created_by,
          job.created_by,
        );
        if (approvers.kind === 'unresolved') {
          throw new ConflictException({
            error_code: ErrorCode.APPROVER_UNRESOLVED,
            message:
              approvers.reason === 'corrupt'
                ? 'The reporting tree has a loop, so this job cannot be routed — fix the reporting line first'
                : 'No active admin can decide this job — add an admin first',
          });
        }
        if (!mayDecide(approvers, owner.userId, false)) {
          throw new ForbiddenException({
            error_code: ErrorCode.FORBIDDEN,
            message: 'This job is waiting for someone else to decide',
          });
        }
      }

      const nextStatus =
        dto.decision === 'approve' ? JobStatus.SCHEDULED : JobStatus.REJECTED;
      const updated = await tx.query<JobRow>(
        `update public.jobs
            set status = $1, decided_by = $2, decided_at = now(),
                rejection_reason = $3, updated_at = now()
          where id = $4 and tenant_id = $5 and status = 'pending_approval'
          returning *`,
        [
          nextStatus,
          owner.userId,
          dto.decision === 'reject' ? reason : null,
          jobId,
          tenantId,
        ],
      );
      const row = updated.rows[0];
      if (updated.rowCount !== 1 || !row) {
        // The row lock serialised us; a miss means another decision won
        // between the check and the write.
        throw new ConflictException({
          error_code: ErrorCode.JOB_NOT_PENDING,
          message: 'This job has already been approved or rejected',
        });
      }
      await tx.query(
        `insert into public.activity_logs (job_id, tenant_id, event_type, actor_id)
         values ($1::uuid, $2::uuid, $3::text, $4::uuid)`,
        [
          jobId,
          tenantId,
          dto.decision === 'approve' ? 'job_approved' : 'job_rejected',
          owner.userId,
        ],
      );
      return row;
    });

    // Creator hears about the decision (story 5), after the commit.
    void alertCreatorOfDecision(
      admin,
      decided,
      owner.userId,
      dto.decision,
      reason,
    );

    return this.toResponse(
      await this.refetchWithEmbeds(admin, jobId, tenantId, decided),
    );
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
      // CAP-5 — the owner may also edit where, what work and for whom.
      dto.serviceLocation,
      dto.skillId,
      dto.customerId,
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

    // The CURRENT technician, read before the RPC so the assignment
    // notification below fires only on an actual CHANGE (a no-op PATCH
    // carrying the incumbent's id must not ring their bell). null means
    // the pre-read found nothing; preReadFailed means it errored — the two are
    // kept apart so a missing job answers 404 and a broken read stays a
    // fail-closed 500.
    // The same read tells the pending-job alerts (story 5) whether the job was
    // pending before this save and which fields really change.
    // A failed read here only loses the alerts; the save itself still goes ahead.
    let before: JobBeforeUpdate | null = null;
    let preReadFailed = false;
    try {
      const { data: current, error } = await admin
        .from('jobs')
        .select(
          'id, tenant_id, job_number, customer_id, created_by, status, technician_id, description, scheduled_start, scheduled_end, notes_for_technician, priority, service_location, skill_id',
        )
        .eq('id', jobId)
        .eq('tenant_id', owner.tenantId)
        .maybeSingle<JobBeforeUpdate>();
      if (error) {
        this.logger.error('Failed to read the job before update:', { error });
        preReadFailed = true;
      } else {
        before = current ?? null;
      }
    } catch (err: unknown) {
      this.logger.error('Failed to read the job before update:', { err });
      preReadFailed = true;
    }
    const previousTechnicianId: string | null = before?.technician_id ?? null;

    // Story 4 / CAP-5: once the owner has decided an employee's job, field edits
    // are refused. Only a pending job takes edits. Owner-created jobs keep their
    // existing flow, and cancel is not an edit. This check runs BEFORE the date
    // checks so a read-only job answers 409, not a date error. The check fails
    // closed: if the job cannot be read, an edit is refused rather than guessed
    // at; if the read worked but found no row, it is a plain 404.
    if (!isCancel) {
      if (preReadFailed) {
        throw new InternalServerErrorException({
          error_code: ErrorCode.INTERNAL_SERVER_ERROR,
          message: 'Could not check the job. Try again.',
        });
      }
      if (!before) {
        throw new NotFoundException({
          error_code: ErrorCode.RESOURCE_NOT_FOUND,
          message: 'Job not found',
        });
      }
      // A failed creator lookup is the same fail-closed refusal (story 5 helper
      // throws on a read error; it must never surface as a raw Postgrest error).
      let creatorIsEmployee: boolean;
      try {
        creatorIsEmployee = await isEmployeeCreator(
          admin,
          owner.tenantId,
          before.created_by ?? null,
        );
      } catch (err: unknown) {
        this.logger.error('Failed to check the job creator:', { err });
        throw new InternalServerErrorException({
          error_code: ErrorCode.INTERNAL_SERVER_ERROR,
          message: 'Could not check the job. Try again.',
        });
      }
      if (editLockedForOwner(before.status, creatorIsEmployee)) {
        throw new HttpException(
          {
            error_code: ErrorCode.JOB_NOT_MODIFIABLE,
            message:
              'An employee job can only be edited while it is pending approval',
          },
          HttpStatus.CONFLICT,
        );
      }
    }

    // A reschedule cannot move a job before today (IST day), same as create.
    // Runs after the edit-lock check above, so a read-only job answers 409.
    if (dto.scheduledStart) {
      assertStartNotInPast(dto.scheduledStart);
    }

    // AC#7 — when reassigning, the new technician must belong to the tenant and be
    // a technician. Mirrors createJob's technician validation exactly.
    if (dto.technicianId) {
      let employee: Awaited<ReturnType<typeof findCompanyMember>>;
      try {
        employee = await findCompanyMember(
          admin,
          owner.tenantId,
          dto.technicianId,
          { role: Role.EMPLOYEE },
        );
      } catch (error) {
        this.logger.error('Failed to validate technician:', { error });
        throw new InternalServerErrorException({
          error_code: ErrorCode.INTERNAL_SERVER_ERROR,
          message: 'Failed to validate technician',
        });
      }
      if (!employee) {
        throw new NotFoundException({
          error_code: ErrorCode.RESOURCE_NOT_FOUND,
          message: 'Technician not found',
        });
      }
      // Parked access, same as createJob: a deactivated member cannot take a
      // reassignment either.
      if (employee.status === 'deactivated') {
        throw new ConflictException({
          error_code: ErrorCode.MEMBERSHIP_STATE,
          message:
            'This member is deactivated — reinstate them before assigning them a job',
        });
      }
    }

    // Atomic edit/reassign/cancel + activity log (AR-10). The status guard (scheduled
    // or pending only) and the per-field audit row live inside the RPC (SELECT … FOR
    // UPDATE) to be TOCTOU-safe; updated_at is
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
      // CAP-5 — the three creator-settable identity fields ride the same
      // coalesce-PATCH RPC; the database validates a moved customer/skill.
      p_service_location: dto.serviceLocation ?? null,
      p_skill_id: dto.skillId ?? null,
      p_customer_id: dto.customerId ?? null,
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
        // Same SQLSTATE, told apart by hint: a pending job's assignee is locked.
        const pendingLock =
          (error as { hint?: string }).hint === 'PENDING_ASSIGNEE_LOCKED';
        throw new HttpException(
          {
            error_code: ErrorCode.VALIDATION_ERROR,
            message: pendingLock
              ? 'A pending job stays with its creator until it is approved'
              : 'scheduledEnd must not be before scheduledStart',
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
      // The RPC refuses a moved customer that is missing or belongs to another
      // company (PT404) — same answer the create flow gives.
      if (code === 'PT404') {
        throw new NotFoundException({
          error_code: ErrorCode.RESOURCE_NOT_FOUND,
          message: 'Referenced customer not found',
        });
      }
      // The RPC refuses a moved skill with no workflow template (PT400) — the
      // same validation the create flow runs before its RPC.
      if (code === 'PT400') {
        throw new BadRequestException({
          error_code: ErrorCode.VALIDATION_ERROR,
          message: 'Unknown or inactive skillId',
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

    // Job assignment is a notification (user decision 2026-11-07): a
    // reassignment to a DIFFERENT technician notifies the new one only —
    // never the acting admin, never the previous technician, never a
    // no-op reassign. Log-and-drop, like the create path.
    if (
      dto.technicianId &&
      previousTechnicianId !== null &&
      dto.technicianId !== previousTechnicianId &&
      rows[0].technician_id !== owner.userId
    ) {
      await insertJobAssignedNotification(
        admin,
        rows[0],
        rows[0].technician_id,
      );
    }

    // Pending-job alerts (story 5), after the RPC commits. Only a job that was
    // and still is pending alerts the creator; a real change makes one alert.
    if (before?.status === JobStatus.PENDING_APPROVAL) {
      if (isCancel && rows[0].status === JobStatus.CANCELLED) {
        void alertCreatorOfCancel(admin, rows[0], owner.userId);
      } else if (!isCancel && rows[0].status === JobStatus.PENDING_APPROVAL) {
        const changed = changedEditFields(before, dto);
        void alertCreatorOfEdit(admin, rows[0], owner.userId, changed);
      }
    }

    return this.toResponse(
      // Same re-fetch as createJob — the RPC returns bare rows (Story 4.5).
      await this.refetchWithEmbeds(admin, jobId, owner.tenantId, rows[0]),
    );
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

    // Story 3.7 — timeline scopes. `today` keeps the Story 3.2 behaviour
    // (IST day window, created_at sort, jobs-list cursor, date re-anchor),
    // except that a technician's in_progress jobs are included with the
    // default view (an active job must not vanish when its slot crosses
    // midnight IST); the other scopes model the full job timeline — `all`
    // (Epic 22) drops even the status predicate, so a pending job has an
    // employee-visible home. The IST day boundary is a DAY boundary, not a
    // time-of-day one, so the three day-buckets stay mutually exclusive by
    // construction.
    const scope = query.scope ?? JobListScope.TODAY;

    // AC #1 / #3 — the IST day window. For an explicit date (today scope only —
    // the DTO rejects date on other scopes), anchor on noon IST (06:30Z) so the
    // instant is unambiguously inside that calendar day; default to the current
    // IST day. Reuses getIstDayRange — no new IST math anywhere.
    const range = query.date
      ? getIstDayRange(new Date(`${query.date}T06:30:00.000Z`))
      : getIstDayRange();

    const admin = this.supabaseClientFactory.createAdmin();

    let qb = admin
      .from('jobs')
      .select(JOB_COLUMNS)
      .eq('tenant_id', user.tenantId);

    // Scope predicate. upcoming/overdue/history force their own status sets;
    // a caller status filter below is intersected with them (empty results are
    // legitimate — the FE never sends such combinations).
    if (scope === JobListScope.TODAY) {
      // A job waiting for owner approval is not work yet, so it is never on the
      // day's list (CAP-4). The approval views show it instead (later stories).
      qb = qb.not(
        'status',
        'in',
        `(${JobStatus.PENDING_APPROVAL},${JobStatus.REJECTED})`,
      );
      // An in-progress job is active work regardless of which IST day its slot
      // was scheduled in — it must not vanish from the technician's list when
      // the slot crosses midnight IST. So for technicians on the default view,
      // today's window is ORed with their in_progress jobs (the technician_id
      // scope below ANDs the OR branch down to their own rows). An
      // explicit `date` re-anchor is a day-history view — keep the pure window
      // there. Company admins always keep the pure day-window view.
      if (user.role === Role.EMPLOYEE && !query.date) {
        qb = qb.or(
          `and(scheduled_start.gte.${range.start.toISOString()},scheduled_start.lt.${range.end.toISOString()}),status.eq.${JobStatus.IN_PROGRESS}`,
        );
      } else {
        qb = qb
          .gte('scheduled_start', range.start.toISOString())
          .lt('scheduled_start', range.end.toISOString());
      }
    } else if (scope === JobListScope.UPCOMING) {
      // Start of tomorrow IST is exactly today's range.end (start + 24h) —
      // zero new IST arithmetic, and today-scheduled jobs can never leak in.
      qb = qb
        .gte('scheduled_start', range.end.toISOString())
        .eq('status', JobStatus.SCHEDULED);
    } else if (scope === JobListScope.OVERDUE) {
      // .in, not .not.in — postgrest-js's not() takes (column, operator, value);
      // chaining .not.in(...) is a property access on a function object and
      // throws at runtime. Equivalent given the status CHECK constraint.
      qb = qb
        .lt('scheduled_start', range.start.toISOString())
        .in('status', [JobStatus.SCHEDULED, JobStatus.IN_PROGRESS]);
    } else if (scope === JobListScope.ALL) {
      // Epic 22 — no status or day predicate: every status of the caller's
      // jobs (employees are self-scoped below), newest-created first. A
      // pending job lives on no other employee scope, so this is what the
      // Jobs tab's "All" and "Pending" chips read. The repeatable status
      // filter below still narrows it when sent.
    } else {
      // A rejected job stays in the creator's history for good (CAP-7).
      qb = qb.in('status', [
        JobStatus.COMPLETED,
        JobStatus.CANCELLED,
        JobStatus.REJECTED,
      ]);
    }

    // AC #2 — repeatable status filter (all scopes; intersects with the scope's
    // forced statuses above, no special-casing).
    if (query.status?.length) {
      qb = qb.in('status', query.status);
    }

    // AC #4 / #5 + 24-2 — row scope. An employee without reports sees ONLY
    // their own jobs (the technicianId param is ignored for them, as today);
    // a manager-employee sees their subtree and may filter inside it; admins
    // and viewers keep the whole company. Common to every scope.
    if (readScopeFor(user.role, 'job.read_all') === 'subtree') {
      const team = await this.teamScope(user);
      if (team) {
        if (query.technicianId && !team.has(query.technicianId)) {
          // Another branch answers exactly like a missing job: no existence leak.
          throw new NotFoundException({
            error_code: ErrorCode.RESOURCE_NOT_FOUND,
            message: 'Not found',
          });
        }
        qb = query.technicianId
          ? qb.eq('technician_id', query.technicianId)
          : // The id list rides the PostgREST URL; real teams are small, but a
            // team in the hundreds would approach the URL limit. If that ever
            // happens, move the predicate into the jobs_overview view rather
            // than chunking the read (chunking breaks the keyset page).
            qb.in('technician_id', [...team]);
      } else {
        qb = qb.eq('technician_id', user.userId);
      }
    } else if (query.technicianId) {
      qb = qb.eq('technician_id', query.technicianId);
    }

    // Keyset pagination. Today keys on created_at DESC; the timeline scopes key
    // on scheduled_start (upcoming/overdue ASC — soonest/oldest problem first;
    // history DESC — most recent planned date first). decodeCursor throws 400
    // on a malformed cursor and on one minted for a different scope.
    const ascending =
      scope === JobListScope.UPCOMING || scope === JobListScope.OVERDUE;
    const sortColumn =
      scope === JobListScope.TODAY || scope === JobListScope.ALL
        ? 'created_at'
        : 'scheduled_start';
    const cursorScope = JOBS_CURSOR_SCOPE_BY_SCOPE[scope];

    if (query.cursor) {
      const c = decodeCursor(query.cursor, cursorScope);
      const op = ascending ? 'gt' : 'lt';
      qb = qb.or(
        `${sortColumn}.${op}.${c.createdAt},and(${sortColumn}.eq.${c.createdAt},id.${op}.${c.id})`,
      );
    }

    const pageSize = query.limit ?? PAGE_SIZE;

    const { data, error } = await qb
      .order(sortColumn, { ascending })
      .order('id', { ascending })
      .limit(pageSize + 1);

    if (error) {
      this.logger.error('Failed to list jobs:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to list jobs',
      });
    }

    // postgrest-js types to-one embeds as arrays even when they arrive as
    // objects — go through `unknown` for the cast (same as users.service).
    const rows = (data ?? []) as unknown as JobRow[];
    const hasMore = rows.length > pageSize;
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
    const last = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor(last.id, last[sortColumn], cursorScope)
        : null;

    // 24-5/CAP-5: the per-row decide gate, from ONE tree read per page. Only
    // pending rows can be decided, so a page with none pays nothing extra.
    const decisions = await this.readJobDecisions(
      user.tenantId,
      pageRows.map((row) => ({
        id: row.id,
        status: row.status,
        createdBy: row.created_by ?? null,
      })),
      user.userId,
    );
    return new PaginatedResponse(
      pageRows.map((row) => ({
        ...this.toResponse(row),
        decision: decisions.get(row.id),
      })),
      nextCursor,
    );
  }

  /**
   * One page of the console's jobs list — the customers-page contract over the
   * jobs_overview view: DB-side filtering/sorting/paging (a company's job
   * history grows without bound, so the list can never be loaded whole), a
   * filtered exact total, and whole-company stats that ignore the filters.
   * Owner-facing (@Can('job.read_all')); the mobile app keeps the cursor
   * listJobs above untouched.
   */
  async getJobsPage(
    owner: RequestUser,
    query: JobsPageQueryDto,
  ): Promise<JobsPage> {
    if (!owner.tenantId) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Company setup required before managing jobs',
      });
    }

    const admin = this.supabaseClientFactory.createAdmin();
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 10;

    // The tenant/search/status/skill/priority filters, applied to a fresh
    // builder — the list query and the past-the-end recount (below) share
    // them. The select expression and its options ride in as parameters
    // because the options-bearing select() overload only exists at the
    // from() level.
    const filtered = (
      columns: string,
      options: { head?: boolean; count?: 'exact' },
    ) => {
      let q = admin
        .from('jobs_overview')
        .select(columns, options)
        .eq('tenant_id', owner.tenantId);

      const term = query.search ? this.sanitizeSearchTerm(query.search) : '';
      if (term) {
        // Inside .or() the ilike wildcard is '*' (PostgREST translates to
        // '%'). The view flattens the joined names, so the search reaches the
        // people and places of a job as plain columns.
        q = q.or(
          `job_number.ilike.*${term}*,description.ilike.*${term}*,service_location.ilike.*${term}*,customer_name.ilike.*${term}*,technician_name.ilike.*${term}*,skill_name.ilike.*${term}*`,
        );
      }

      if (query.status) q = q.eq('status', query.status);
      if (query.skillId) q = q.eq('skill_id', query.skillId);
      if (query.priority) q = q.eq('priority', query.priority);
      if (query.technicianId) q = q.eq('technician_id', query.technicianId);

      return q;
    };

    let qb = filtered('*', { count: 'exact' });

    // Every sort carries an id tiebreak, so two rows that share the sort key
    // can never straddle a page boundary.
    switch (query.sort) {
      case 'soonest':
        // Earliest scheduled first; a job with no date sorts last (nullsFirst:
        // false on an ascending order puts the nulls at the end).
        qb = qb
          .order('scheduled_start', { ascending: true, nullsFirst: false })
          .order('id', { ascending: true });
        break;
      default:
        qb = qb
          .order('created_at', { ascending: false })
          .order('id', { ascending: false });
    }

    const [listResult, stats] = await Promise.all([
      qb.range((page - 1) * pageSize, page * pageSize - 1),
      // With a technician filter the stats describe THAT employee's jobs —
      // the profile page's chips must tell the truth about the person, and
      // the jobs page (no filter) keeps the whole-company counts.
      this.getJobsStats(owner.tenantId, query.technicianId),
    ]);

    const { data, error, count } = listResult;
    if (error) {
      // A page entirely past the end (a hand-edited address — the app's own
      // pager clamps) is an EMPTY page, not a failure: PostgREST answers
      // PGRST103. The filtered total still counts, so the envelope stays
      // honest and the pager shows the real last page.
      if (error.code === 'PGRST103') {
        const { count: recount, error: recountError } = await filtered('id', {
          count: 'exact',
          head: true,
        });
        if (recountError) {
          this.logger.error('Failed to recount jobs:', { error: recountError });
          throw new InternalServerErrorException({
            error_code: ErrorCode.INTERNAL_SERVER_ERROR,
            message: 'Failed to list jobs',
          });
        }
        const recountTotal = recount ?? 0;
        return {
          data: [],
          total: recountTotal,
          page,
          pageSize,
          pages: Math.max(1, Math.ceil(recountTotal / pageSize)),
          stats,
        };
      }
      this.logger.error('Failed to list jobs page:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to list jobs',
      });
    }

    const total = count ?? 0;
    // The select expression is a parameter, so postgrest-js can't narrow the
    // row type — the double cast just restores the shape we asked for.
    const rows = (data ?? []) as unknown as JobsOverviewRow[];

    return {
      data: rows.map((row) => this.toPageItem(row)),
      total,
      page,
      pageSize,
      pages: Math.max(1, Math.ceil(total / pageSize)),
      stats,
    };
  }

  /**
   * The whole-company counters the console's job stat tiles show, counted
   * before any filter (the members/customers stats contract). One head-count
   * query per status plus the whole tenant run in one Promise.all: each
   * transfers only its count (head: true,
   * no rows), so all four cost one wall-clock round trip and the fold never
   * scales with job volume.
   */
  private async getJobsStats(
    tenantId: string,
    technicianId?: string,
  ): Promise<JobsStats> {
    const admin = this.supabaseClientFactory.createAdmin();
    const cutoff = new Date(
      Date.now() - 30 * 24 * 60 * 60 * 1000,
    ).toISOString();

    // One head-count query per status plus the whole tenant — each transfers
    // only its count, so the whole fold still costs one wall-clock round trip.
    // An optional technician scope narrows every count (profile page).
    const countByStatus = async (status: JobStatus) => {
      let q = admin
        .from('jobs_overview')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .eq('status', status);
      if (technicianId) q = q.eq('technician_id', technicianId);
      return q;
    };

    const wholeTenant = () => {
      let q = admin
        .from('jobs_overview')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId);
      if (technicianId) q = q.eq('technician_id', technicianId);
      return q;
    };

    const [
      totalQ,
      scheduledQ,
      inProgressQ,
      pendingQ,
      completedQ,
      cancelledQ,
      rejectedQ,
      completed30dQ,
    ] = await Promise.all([
      wholeTenant(),
      countByStatus(JobStatus.SCHEDULED),
      countByStatus(JobStatus.IN_PROGRESS),
      countByStatus(JobStatus.PENDING_APPROVAL),
      countByStatus(JobStatus.COMPLETED),
      countByStatus(JobStatus.CANCELLED),
      countByStatus(JobStatus.REJECTED),
      (() => {
        let q = admin
          .from('jobs_overview')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', tenantId)
          .eq('status', JobStatus.COMPLETED)
          .gte('completed_at', cutoff);
        if (technicianId) q = q.eq('technician_id', technicianId);
        return q;
      })(),
    ]);

    const counted = [
      totalQ,
      scheduledQ,
      inProgressQ,
      pendingQ,
      completedQ,
      cancelledQ,
      rejectedQ,
      completed30dQ,
    ];
    for (const result of counted) {
      if (result.error) {
        this.logger.error('Failed to count jobs:', { error: result.error });
        throw new InternalServerErrorException({
          error_code: ErrorCode.INTERNAL_SERVER_ERROR,
          message: 'Failed to count jobs',
        });
      }
    }

    return {
      total: totalQ.count ?? 0,
      scheduled: scheduledQ.count ?? 0,
      inProgress: inProgressQ.count ?? 0,
      pendingApproval: pendingQ.count ?? 0,
      completed: completedQ.count ?? 0,
      cancelled: cancelledQ.count ?? 0,
      rejected: rejectedQ.count ?? 0,
      completed30d: completed30dQ.count ?? 0,
    };
  }

  /** jobs_overview row → the lean page-item shape the web console reads. */
  private toPageItem(row: JobsOverviewRow): JobPageItem {
    // Lenient like every job read: an unreadable template (unreachable under
    // the FK + no-delete posture) maps to null fields, never a 500.
    const steps = row.template_steps
      ? parseTemplateSteps(row.template_steps)
      : null;
    return {
      id: row.id,
      jobNumber: row.job_number,
      status: row.status,
      priority: row.priority,
      scheduledStart: row.scheduled_start,
      currentStep: row.current_step,
      skill:
        row.skill_id && row.skill_name
          ? { id: row.skill_id, name: row.skill_name }
          : null,
      technician: row.technician_id
        ? { id: row.technician_id, name: row.technician_name ?? null }
        : null,
      customer: row.customer_id
        ? { id: row.customer_id, name: row.customer_name ?? null }
        : null,
      description: row.description,
      serviceLocation: row.service_location,
      completedAt: row.completed_at,
      createdAt: row.created_at,
      decidedAt: row.decided_at ?? null,
      rejectionReason: row.rejection_reason ?? null,
      workflowTemplate:
        steps && row.template_version != null
          ? { version: row.template_version, steps: steps.map(stepToResponse) }
          : null,
      currentStepIndex: steps
        ? currentStepIndexForRead(steps, row.current_step)
        : null,
    };
  }

  /**
   * Neutralizes PostgREST/LIKE-significant characters before a term is
   * interpolated into an unsanitized `.or()` filter string (the customers
   * service's copy of the same contract):
   * - escapes LIKE metacharacters `%` and `_` so they match literally
   * - strips PostgREST-structural chars (`, ( )`), the `*` wildcard, and
   *   backslash (`.` and `:` are safe inside an ilike value and are preserved)
   * Returns the cleaned term ('' means "no search filter").
   */
  private sanitizeSearchTerm(q: string): string {
    return q
      .replace(/[,()*\\]/g, '')
      .replace(/[%_]/g, (m) => `\\${m}`)
      .trim();
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
      .select(JOB_COLUMNS)
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

    // 2) Ownership gate — an employee may only view jobs assigned to them. A job
    //    that is someone else's answers exactly like a missing one (CAP-7): not
    //    found, never a hint that it exists.
    // A manager-employee may open their subtree's jobs; anyone else's answers
    // exactly like a missing one. The attachment URLs below are minted only
    // after this gate, so the subtree check precedes signing (CAP-2).
    if (readScopeFor(user.role, 'job.read_all') === 'subtree') {
      const team = await this.teamScope(user);
      const visible = team
        ? team.has(row.technician_id)
        : row.technician_id === user.userId;
      if (!visible) {
        throw new NotFoundException({
          error_code: ErrorCode.RESOURCE_NOT_FOUND,
          message: 'Job not found',
        });
      }
    }

    // 3) Assemble related records in parallel — reads need no atomicity (AR-10
    //    governs writes). technician_id / customer_id are NOT NULL FKs, so the
    //    rows always exist; a missing row is a server fault (500), not a 404.
    const [techRes, skillRes, custRes, logRes, attachRes] = await Promise.all([
      // History view: a removed employee's name still shows on their old jobs.
      findCompanyMember(admin, user.tenantId, row.technician_id, {
        includeRemoved: true,
      }).then(
        (m) => ({
          data: m
            ? ({
                id: m.userId,
                name: m.name,
                country_code: m.countryCode,
                phone_number: m.phoneNumber,
                avatar_key: m.avatarKey,
              } as TechnicianRow)
            : null,
          error: null as unknown,
        }),
        (error: unknown) => ({ data: null as TechnicianRow | null, error }),
      ),
      admin
        .from('user_skills')
        // Skills come from the global catalog (Story 4.2) — no tenant scoping
        // applies; the technician row is already tenant-verified above.
        .select('skills!inner(name)')
        .eq('user_id', row.technician_id),
      admin
        .from('customers')
        .select(
          'id, name, country_code, phone_number, address, city, latitude, longitude, address_details, formatted_address',
        )
        .eq('id', row.customer_id)
        .eq('tenant_id', user.tenantId)
        .single<CustomerProfileRow>(),
      admin
        .from('activity_logs')
        .select(
          'id, event_type, actor_id, metadata, created_at, users!activity_logs_actor_id_fkey(name)',
        )
        .eq('job_id', jobId)
        .eq('tenant_id', user.tenantId)
        .order('created_at', { ascending: true }),
      admin
        .from('attachments')
        .select('id, attachment_type, r2_key, created_at')
        .eq('job_id', jobId)
        .eq('tenant_id', user.tenantId)
        // Photos hidden after a report are never shown to anyone.
        .is('hidden_at', null)
        .order('created_at', { ascending: true }),
    ]);

    // A 0-row `.single()` on technician/customer returns `error.code ===
    // 'PGRST116'` (not data:null), so exclude it here and let the missing-row
    // branch below handle it — otherwise the ID-naming diagnostic log never
    // fires. Any other error on any of the four reads is a genuine fault → 500.
    const realError =
      techRes.error ||
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
        const s = r.skills;
        if (Array.isArray(s)) return s.map((t) => t.name);
        return s ? [s.name] : [];
      })
      // Guard against a null/empty name slipping through either embed shape.
      .filter((name): name is string => Boolean(name));

    const activityLog = ((logRes.data ?? []) as ActivityLogRow[]).map((l) => ({
      id: l.id,
      eventType: l.event_type,
      actorId: l.actor_id,
      // Null only if the embed came back unreadable (actor_id is a NOT NULL FK
      // to users, so a real row always has a name under it).
      actorName: embedUserName(l.users),
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

    const technicianAvatarKey = techRes.data?.avatar_key ?? null;
    const technicianAvatarUrl = avatarUrlFor(
      await presignAvatarUrls(this.storageService, [technicianAvatarKey]),
      technicianAvatarKey,
    );

    const detail = this.toDetailResponse(
      row,
      techRes.data,
      skills,
      custRes.data,
      activityLog,
      attachments,
      technicianAvatarUrl,
    );
    // 24-5/CAP-5: the decide gate for THIS row, from the same walk the POST
    // runs. A read failure degrades to "not decidable" rather than a 500 —
    // the detail itself already loaded.
    const decisions = await this.readJobDecisions(
      user.tenantId,
      [
        {
          id: row.id,
          status: row.status,
          createdBy: row.created_by ?? null,
        },
      ],
      user.userId,
    );
    return { ...detail, decision: decisions.get(row.id) };
  }

  private toDetailResponse(
    row: JobRow,
    technician: TechnicianRow,
    skills: string[],
    customer: CustomerProfileRow,
    activityLog: ActivityLogEntry[],
    attachments: JobAttachmentResponse[],
    technicianAvatarUrl: string | null,
  ): JobDetailResponse {
    return {
      ...this.toResponse(row),
      technician: {
        id: technician.id,
        name: technician.name,
        countryCode: technician.country_code,
        phoneNumber: technician.phone_number,
        skills,
        avatarUrl: technicianAvatarUrl,
      },
      customer: {
        id: customer.id,
        name: customer.name,
        countryCode: customer.country_code,
        phoneNumber: customer.phone_number,
        address: customer.address,
        city: customer.city,
        latitude: customer.latitude,
        longitude: customer.longitude,
        addressDetails: customer.address_details,
        formattedAddress: customer.formatted_address,
      },
      activityLog,
      attachments,
    };
  }

  // Public so WorkflowService (same module) can reuse the snake→camel mapping
  // without re-deriving it (Story 3.5).
  toResponse(row: JobRow): JobResponse {
    // Story 4.5 — the stamped skill + template ride every response. A missing
    // or unreadable template embed is unreachable under the FK + immutable-
    // stamp + no-delete posture, but reads stay soft: null fields, never a
    // 500 (the advance path keeps its strict guard; reads are lenient).
    const templateRaw = row.workflow_templates;
    const steps = templateRaw ? parseTemplateSteps(templateRaw.steps) : null;
    return {
      id: row.id,
      jobNumber: row.job_number,
      tenantId: row.tenant_id,
      customerId: row.customer_id,
      technicianId: row.technician_id,
      serviceLocation: row.service_location,
      scheduledStart: row.scheduled_start,
      scheduledEnd: row.scheduled_end,
      status: row.status,
      completedAt: row.completed_at,
      currentStep: row.current_step,
      priority: row.priority,
      description: row.description,
      notesForTechnician: row.notes_for_technician,
      // Epic 22 — `?? null` keeps write-path fallback rows (bare RPC returns
      // without these columns) mapping to null instead of dropping the keys.
      createdBy: row.created_by ?? null,
      decidedAt: row.decided_at ?? null,
      rejectionReason: row.rejection_reason ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      skill: normalizeSkillEmbed<JobSkillResponse>(row.skills),
      technician: normalizeSkillEmbed<{ id: string; name: string | null }>(
        (
          row as JobRow & {
            technician?: { id: string; name: string | null } | null;
          }
        ).technician,
      ),
      customer: normalizeSkillEmbed<{ id: string; name: string | null }>(
        (
          row as JobRow & {
            customer?: { id: string; name: string | null } | null;
          }
        ).customer,
      ),
      workflowTemplate:
        steps && templateRaw
          ? {
              version: templateRaw.version,
              steps: steps.map(stepToResponse),
            }
          : null,
      currentStepIndex: steps
        ? currentStepIndexForRead(steps, row.current_step)
        : null,
    };
  }

  /**
   * Story 4.5 — re-fetch a just-written job with the skill/template embeds so
   * create/update/advance responses carry the same shape reads do (the write
   * RPCs return bare job rows, without embeds). A failed re-fetch degrades to
   * the fallback row — the operation itself already succeeded, so the response
   * keeps its fields with null embeds rather than turning a successful write
   * into a 500.
   */
  async refetchWithEmbeds(
    admin: SupabaseClient,
    jobId: string,
    tenantId: string,
    fallback: JobRow,
  ): Promise<JobRow> {
    const { data, error } = await admin
      .from('jobs')
      .select(JOB_COLUMNS)
      .eq('id', jobId)
      .eq('tenant_id', tenantId)
      .maybeSingle<JobRow>();

    if (error || !data) {
      this.logger.error('Failed to re-fetch job with embeds:', {
        error,
        jobId,
      });
      return fallback;
    }
    return data;
  }
}
