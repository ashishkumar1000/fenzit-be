import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { ErrorCode } from '../common/enums/error-code.enum';
import { MembershipRole, Role } from '../common/enums/role.enum';
import { RequestUser } from '../common/interfaces/request-user.interface';
import {
  CompanyMember,
  findCompanyMember,
  listCompanyMembers,
} from '../common/members/company-members';
import { PgPoolFactory } from '../common/pg/pg-pool.factory';
import { memberRpcException } from '../common/members/member-rpc-error';
import {
  avatarUrlFor,
  presignAvatarUrls,
} from '../common/members/member-avatars';
import { StorageService } from '../storage/storage.service';
import { MembersPageQueryDto } from './dto/members-page-query.dto';
import { UpdateEmploymentDto } from './dto/update-employment.dto';
import { EmploymentView } from './dto/employment-view.dto';

/** A person of the company as the members list serves them: no raw storage key. */
export type MemberView = Omit<CompanyMember, 'avatarKey'> & {
  /** Short-lived link to the person's photo, or null when none is set. */
  avatarUrl: string | null;
};

/** The whole-company counters the console's stat tiles show. They count the
 *  team before any filter, so tiles stay stable while the table narrows. */
export interface MembersStats {
  total: number;
  active: number;
  invited: number;
  /** Members parked by the owner (status `deactivated`). */
  deactivated: number;
  /** Active employees whose jobs wait for the owner's approval first. */
  needsApproval: number;
  /** Per-role counts for the role dropdown's option rows. */
  byRole: {
    all: number;
    company_admin: number;
    employee: number;
    viewer: number;
  };
  /** Per job-setting counts for that dropdown: cannot create, creates
   *  freely, creates but the owner approves first. */
  byJobSetting: {
    all: number;
    off: number;
    createOnly: number;
    approval: number;
  };
}

/** One page of the team list, the shape GET /members/page answers with. */
export interface MembersPage {
  data: MemberView[];
  /** How many rows the current filters keep, across all pages. */
  total: number;
  page: number;
  pageSize: number;
  pages: number;
  stats: MembersStats;
}

/** Newest join first by default; the mockup's "Joined (Newest)". */
function byJoinedAsc(a: CompanyMember, b: CompanyMember): number {
  return a.createdAt.localeCompare(b.createdAt);
}

/** Names sort with nulls last, the way a person expects an incomplete record. */
function byNameAz(a: CompanyMember, b: CompanyMember): number {
  const an = a.name ?? '￿';
  const bn = b.name ?? '￿';
  return an.localeCompare(bn);
}

/** Employee codes are a fixed-width sequence, so plain byte order sorts them
 *  the way a person reads the list: EMP-001 before EMP-002. */
function byCode(a: CompanyMember, b: CompanyMember): number {
  return a.employeeCode.localeCompare(b.employeeCode);
}

export interface AuditLogEntry {
  id: string;
  createdAt: string;
  actorUserId: string;
  actorIsPlatformAdmin: boolean;
  tenantId: string | null;
  action: string;
  targetUserId: string | null;
  details: Record<string, unknown>;
}

interface EmploymentRow {
  user_id: string;
  employee_code: string;
  join_date: string | null;
  exit_date: string | null;
  pan: string | null;
  date_of_birth: string | null;
  father_name: string | null;
  mother_name: string | null;
  spouse_name: string | null;
  pf_account_number: string | null;
  uan_number: string | null;
  designation: string | null;
  department: string | null;
  bank_account_number: string | null;
  ifsc_code: string | null;
  bank_name: string | null;
}

const EMPLOYMENT_COLUMNS =
  'user_id, employee_code, join_date, exit_date, pan, date_of_birth, father_name, mother_name, spouse_name, pf_account_number, uan_number, designation, department, bank_account_number, ifsc_code, bank_name';

/** DTO key → column, for the plain text fields (trim, empty after trim clears). */
const EMPLOYMENT_TEXT_FIELDS: Array<
  [keyof UpdateEmploymentDto, keyof EmploymentRow]
> = [
  ['pan', 'pan'],
  ['fatherName', 'father_name'],
  ['motherName', 'mother_name'],
  ['spouseName', 'spouse_name'],
  ['pfAccountNumber', 'pf_account_number'],
  ['uanNumber', 'uan_number'],
  ['designation', 'designation'],
  ['department', 'department'],
  ['bankAccountNumber', 'bank_account_number'],
  ['ifscCode', 'ifsc_code'],
  ['bankName', 'bank_name'],
];

/** DTO key → column, for the calendar dates. */
const EMPLOYMENT_DATE_FIELDS: Array<
  [keyof UpdateEmploymentDto, keyof EmploymentRow]
> = [
  ['joinDate', 'join_date'],
  ['exitDate', 'exit_date'],
  ['dateOfBirth', 'date_of_birth'],
];

function toEmploymentView(row: EmploymentRow): EmploymentView {
  return {
    userId: row.user_id,
    employeeCode: row.employee_code,
    joinDate: row.join_date,
    exitDate: row.exit_date,
    pan: row.pan,
    dateOfBirth: row.date_of_birth,
    fatherName: row.father_name,
    motherName: row.mother_name,
    spouseName: row.spouse_name,
    pfAccountNumber: row.pf_account_number,
    uanNumber: row.uan_number,
    designation: row.designation,
    department: row.department,
    bankAccountNumber: row.bank_account_number,
    ifscCode: row.ifsc_code,
    bankName: row.bank_name,
  };
}

/** Absent stays absent; a trimmed-empty string becomes a clear (null). */
function normalisedText(
  value: string | null | undefined,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * A `YYYY-MM-DD` string that names a real calendar day, returned unchanged;
 * `null` when the day does not exist (2026-02-30) or the shape is off. The
 * shape is already checked by the DTO; this re-check keeps the service honest
 * when it is called from anywhere else.
 */
function realCalendarDate(value: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (
    day.getUTCFullYear() !== y ||
    day.getUTCMonth() !== mo - 1 ||
    day.getUTCDate() !== d
  ) {
    return null;
  }
  return value;
}

/** Absent → undefined (untouched), null or a parsed real date; null if fake. */
function normalisedDate(
  value: string | null | undefined,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return realCalendarDate(value);
}

const DEFAULT_AUDIT_LIMIT = 50;

/**
 * People of a company and who changed what. The rules (no self change, a
 * company always keeps an admin, every change audited in the same step) live
 * in the database functions, so a bug here cannot bypass them; this service
 * only checks the caller's permission (the guard) and maps errors.
 */
@Injectable()
export class MembersService {
  private readonly logger = new Logger(MembersService.name);

  constructor(
    private readonly supabaseFactory: SupabaseClientFactory,
    private readonly storageService: StorageService,
    private readonly pgPool: PgPoolFactory,
  ) {}

  async list(caller: RequestUser): Promise<MemberView[]> {
    try {
      const members = await listCompanyMembers(
        this.supabaseFactory.createAdmin(),
        caller.tenantId as string,
        { includeRemoved: false },
      );
      const avatarUrls = await presignAvatarUrls(
        this.storageService,
        members.map((m) => m.avatarKey),
      );
      return members.map(({ avatarKey, ...member }) => ({
        ...member,
        avatarUrl: avatarUrlFor(avatarUrls, avatarKey),
      }));
    } catch (error) {
      this.logger.error('Failed to list members:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to list members',
      });
    }
  }

  /**
   * The console's paged team list. Reads the company's members once with the
   * plain members query (no database function), then filters, sorts and
   * pages in the service, so the contract stays in one file and no new SQL
   * surface exists. Stats always describe the whole team, so the tiles do not
   * move when a filter is on.
   */
  async listPaged(
    caller: RequestUser,
    query: MembersPageQueryDto,
  ): Promise<MembersPage> {
    try {
      const all = await listCompanyMembers(
        this.supabaseFactory.createAdmin(),
        caller.tenantId as string,
        { includeRemoved: false },
      );

      /** The member's job-setting bucket, in the query-param's vocabulary. */
      const jobSplit = (
        m: CompanyMember,
      ): 'off' | 'create_only' | 'approval' => {
        if (!m.canCreateJobs) return 'off';
        return m.jobApprovalRequired ? 'approval' : 'create_only';
      };
      const stats = {
        total: all.length,
        active: all.filter((m) => m.status === 'active').length,
        invited: all.filter((m) => m.status === 'invited').length,
        deactivated: all.filter((m) => m.status === 'deactivated').length,
        needsApproval: all.filter(
          (m) =>
            m.status === 'active' && m.canCreateJobs && m.jobApprovalRequired,
        ).length,
        byRole: {
          all: all.length,
          company_admin: all.filter((m) => m.role === Role.COMPANY_ADMIN)
            .length,
          employee: all.filter((m) => m.role === Role.EMPLOYEE).length,
          viewer: all.filter((m) => m.role === Role.VIEWER).length,
        },
        byJobSetting: {
          all: all.length,
          off: all.filter((m) => jobSplit(m) === 'off').length,
          createOnly: all.filter((m) => jobSplit(m) === 'create_only').length,
          approval: all.filter((m) => jobSplit(m) === 'approval').length,
        },
      };

      let rows = all;
      if (query.status !== undefined && query.status !== 'all') {
        rows = rows.filter((m) => m.status === query.status);
      }
      if (query.role !== undefined && query.role !== 'all') {
        rows = rows.filter((m) => m.role === query.role);
      }
      if (query.jobSetting !== undefined && query.jobSetting !== 'all') {
        rows = rows.filter((m) => jobSplit(m) === query.jobSetting);
      }
      if (query.search !== undefined && query.search !== '') {
        const needle = query.search.trim().toLowerCase();
        const digits = needle.replace(/\D/g, '');
        rows = rows.filter((m) => {
          if ((m.name ?? '').toLowerCase().includes(needle)) return true;
          if (m.employeeCode.toLowerCase().includes(needle)) return true;
          return digits !== '' && m.phoneNumber.includes(digits);
        });
      }
      switch (query.sort ?? 'joined_new') {
        case 'joined_old':
          rows = [...rows].sort(byJoinedAsc);
          break;
        case 'name_az':
          rows = [...rows].sort(byNameAz);
          break;
        case 'name_za':
          rows = [...rows].sort((a, b) => -byNameAz(a, b));
          break;
        case 'code_az':
          rows = [...rows].sort(byCode);
          break;
        case 'code_za':
          rows = [...rows].sort((a, b) => -byCode(a, b));
          break;
        default:
          rows = [...rows].sort((a, b) => -byJoinedAsc(a, b));
      }

      const total = rows.length;
      const page = query.page ?? 1;
      const pageSize = query.pageSize ?? 10;
      const pages = Math.max(1, Math.ceil(total / pageSize));
      const safePage = Math.min(page, pages);
      const slice = rows.slice((safePage - 1) * pageSize, safePage * pageSize);

      // Only the returned page needs a signed photo link.
      const avatarUrls = await presignAvatarUrls(
        this.storageService,
        slice.map((m) => m.avatarKey),
      );
      const data: MemberView[] = slice.map(({ avatarKey, ...member }) => ({
        ...member,
        avatarUrl: avatarUrlFor(avatarUrls, avatarKey),
      }));

      return { data, total, page: safePage, pageSize, pages, stats };
    } catch (error) {
      this.logger.error('Failed to list the paged members:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to list members',
      });
    }
  }

  /**
   * One member of the company, as the list serves them (plus skills). The
   * statutory fields deliberately stay behind GET /members/:userId/employment
   * — the 23-1 privacy invariant keeps PAN/DOB/PF/UAN/bank off every other
   * member surface. A removed member answers 404: the lists hide them, and
   * the profile is a list sibling.
   */
  async getMember(caller: RequestUser, memberUserId: string): Promise<MemberView> {
    if (!caller.tenantId) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Company setup required before managing members',
      });
    }
    try {
      const member = await findCompanyMember(
        this.supabaseFactory.createAdmin(),
        caller.tenantId,
        memberUserId,
        { withSkills: true },
      );
      if (!member) {
        throw new NotFoundException({
          error_code: ErrorCode.RESOURCE_NOT_FOUND,
          message: 'The person is not a member of this company',
        });
      }
      const avatarUrls = await presignAvatarUrls(
        this.storageService,
        [member.avatarKey],
      );
      const { avatarKey, ...rest } = member;
      return { ...rest, avatarUrl: avatarUrlFor(avatarUrls, avatarKey) };
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      this.logger.error('Failed to read the member:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to read the member',
      });
    }
  }

  /**
   * The owner parks or reinstates a member (employee profile story). The
   * rules mirror the role-change and remove functions: never yourself, an
   * active company always keeps an admin, a move only leaves the state it
   * names. Those rules hold together inside ONE pg transaction under the
   * exclusive tenant lock (the same lock space the member functions use), so
   * two concurrent deactivations cannot both pass the last-admin count.
   */
  async setActive(
    caller: RequestUser,
    memberUserId: string,
    active: boolean,
  ): Promise<{ userId: string; status: string; employeeCode: string }> {
    if (!caller.tenantId) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Company setup required before managing members',
      });
    }
    if (caller.userId === memberUserId) {
      throw new ForbiddenException({
        error_code: ErrorCode.MEMBERSHIP_SELF,
        message: 'You cannot change your own access — ask another admin',
      });
    }
    const tenantId = caller.tenantId;
    const expectedFrom = active ? 'deactivated' : 'active';
    const newStatus = active ? 'active' : 'deactivated';

    const outcome = await this.pgPool.withTransaction(async (tx) => {
      // Exclusive tenant lock: serialized against the member functions'
      // role-change/remove, which count admins under the same lock.
      await tx.query('select public.attendance_lock_tenant($1, true)', [
        tenantId,
      ]);
      const member = await tx.query<{
        status: string;
        role: string;
        employee_code: string;
      }>(
        `select status, role, employee_code from public.memberships
          where user_id = $1 and tenant_id = $2 for update`,
        [memberUserId, tenantId],
      );
      const row = member.rows[0];
      if (!row) {
        throw new NotFoundException({
          error_code: ErrorCode.RESOURCE_NOT_FOUND,
          message: 'The person is not a member of this company',
        });
      }
      if (row.status !== expectedFrom) {
        throw new ConflictException({
          error_code: ErrorCode.MEMBERSHIP_STATE,
          message:
            active
              ? 'Only a deactivated member can be reinstated'
              : 'Only an active member can be deactivated',
        });
      }
      if (!active && row.role === Role.COMPANY_ADMIN) {
        const others = await tx.query<{ n: number }>(
          `select count(*)::int as n from public.memberships m
             join public.users u on u.id = m.user_id
            where m.tenant_id = $1 and m.role = 'company_admin'
              and m.status = 'active' and m.user_id <> $2 and not u.disabled`,
          [tenantId, memberUserId],
        );
        if ((others.rows[0]?.n ?? 0) === 0) {
          throw new ConflictException({
            error_code: ErrorCode.LAST_ADMIN,
            message: 'The company must keep at least one active admin',
          });
        }
      }
      const updated = await tx.query<{ status: string }>(
        `update public.memberships set status = $1, updated_at = now()
          where user_id = $2 and tenant_id = $3 and status = $4
          returning status`,
        [newStatus, memberUserId, tenantId, expectedFrom],
      );
      if (updated.rowCount !== 1) {
        // The guarded write is the race backstop; under the exclusive lock it
        // should never miss — treat a miss as the conflict it would be.
        throw new ConflictException({
          error_code: ErrorCode.MEMBERSHIP_STATE,
          message: 'The member changed since it was read — reload and retry',
        });
      }
      return { employeeCode: row.employee_code };
    });

    // Audit after the commit, the employment-save way: what happened, never
    // the values behind it; a failed audit entry does not undo the write.
    try {
      const auditCall = (await this.supabaseFactory
        .createAdmin()
        .rpc('write_audit_row', {
          p_actor: caller.userId,
          p_action: active ? 'member.reinstated' : 'member.deactivated',
          p_tenant_id: tenantId,
          p_target_user: memberUserId,
          p_details: { employee_code: outcome.employeeCode },
        })) as { error: { code?: string; message?: string } | null };
      if (auditCall.error) {
        this.logger.error('Failed to write the member audit entry:', {
          error: auditCall.error,
        });
      }
    } catch (auditError: unknown) {
      this.logger.error('Failed to write the member audit entry:', {
        error: auditError,
      });
    }

    return { userId: memberUserId, status: newStatus, employeeCode: outcome.employeeCode };
  }

  async changeRole(
    caller: RequestUser,
    memberUserId: string,
    newRole: MembershipRole,
  ): Promise<{ userId: string; oldRole: string; newRole: string }> {
    const { data, error } = await this.supabaseFactory
      .createAdmin()
      .rpc('change_member_role', {
        p_caller: caller.userId,
        p_tenant_id: caller.tenantId,
        p_member_user_id: memberUserId,
        p_new_role: newRole,
      });
    if (error) {
      throw this.mapError(error, 'Failed to change the role');
    }
    // The database always returns the old and new role on success. A missing row
    // is a broken contract, so fail loudly rather than report a made-up change.
    const row = (data as Array<Record<string, string>> | null)?.[0];
    if (!row?.['old_role'] || !row?.['new_role']) {
      this.logger.error('change_member_role returned no role change');
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to change the role',
      });
    }
    return {
      userId: memberUserId,
      oldRole: row['old_role'],
      newRole: row['new_role'],
    };
  }

  /**
   * Owner sets an employee's two job switches (CAP-1). One database call does
   * the check, the change and its audit row together.
   */
  async setJobSettings(
    caller: RequestUser,
    memberUserId: string,
    settings: { canCreateJobs: boolean; jobApprovalRequired: boolean },
  ): Promise<{
    userId: string;
    canCreateJobs: boolean;
    jobApprovalRequired: boolean;
  }> {
    // Company setup first, like the sibling write endpoints: without a company
    // of their own there is nothing to manage, and the RPC would answer with a
    // misleading permission 403 instead of this plain company-setup 400.
    if (!caller.tenantId) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Company setup required before managing members',
      });
    }
    const { data, error } = await this.supabaseFactory
      .createAdmin()
      .rpc('set_member_job_settings', {
        p_caller: caller.userId,
        p_tenant_id: caller.tenantId,
        p_member_user_id: memberUserId,
        p_can_create_jobs: settings.canCreateJobs,
        p_job_approval_required: settings.jobApprovalRequired,
      });
    if (error) {
      throw this.mapError(error, 'Failed to update the job settings');
    }
    const row = (
      data as Array<{
        member_id: string;
        can_create_jobs: boolean;
        job_approval_required: boolean;
      }> | null
    )?.[0];
    if (!row) {
      this.logger.error('set_member_job_settings returned no row');
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to update the job settings',
      });
    }
    return {
      userId: memberUserId,
      canCreateJobs: row.can_create_jobs,
      jobApprovalRequired: row.job_approval_required,
    };
  }

  async remove(caller: RequestUser, memberUserId: string): Promise<void> {
    const { error } = await this.supabaseFactory
      .createAdmin()
      .rpc('remove_member', {
        p_caller: caller.userId,
        p_tenant_id: caller.tenantId,
        p_member_user_id: memberUserId,
      });
    if (error) {
      throw this.mapError(error, 'Failed to remove the member');
    }
  }

  /**
   * The membership read behind GET/PATCH employment. Read straight from the
   * table by (user_id, tenant_id) with NO status filter: a removed member's
   * exit date is exactly what the owner fixes here, so unlike the member
   * lists this read must not hide removed rows.
   */
  private async readEmploymentRow(
    admin: ReturnType<SupabaseClientFactory['createAdmin']>,
    tenantId: string,
    memberUserId: string,
  ): Promise<EmploymentRow | null> {
    const { data, error } = await admin
      .from('memberships')
      .select(EMPLOYMENT_COLUMNS)
      .eq('user_id', memberUserId)
      .eq('tenant_id', tenantId)
      .maybeSingle<EmploymentRow>();
    if (error) {
      this.logger.error('Failed to read the employment record:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to read the employment record',
      });
    }
    return data ?? null;
  }

  async getEmployment(
    caller: RequestUser,
    memberUserId: string,
  ): Promise<EmploymentView> {
    if (!caller.tenantId) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Company setup required before managing members',
      });
    }
    const row = await this.readEmploymentRow(
      this.supabaseFactory.createAdmin(),
      caller.tenantId,
      memberUserId,
    );
    if (!row) {
      throw new NotFoundException({
        error_code: ErrorCode.RESOURCE_NOT_FOUND,
        message: 'The person is not a member of this company',
      });
    }
    return toEmploymentView(row);
  }

  /**
   * The owner saves one employee's employment record (CAP-13). Every rule is
   * judged on the state the row will have AFTER the save, so clearing the
   * join date and setting an exit in one request is refused the same way as
   * the two steps would be. Nothing here touches the database functions: the
   * write is a plain guarded UPDATE with an explicit field list, and the only
   * cross-writer hazard (a duplicate employee code) is probed here and
   * backstopped by mapping the database's 23505 to a 409.
   */
  async updateEmployment(
    caller: RequestUser,
    memberUserId: string,
    dto: UpdateEmploymentDto,
  ): Promise<EmploymentView> {
    if (!caller.tenantId) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Company setup required before managing members',
      });
    }
    const tenantId = caller.tenantId;
    const admin = this.supabaseFactory.createAdmin();
    const row = await this.readEmploymentRow(admin, tenantId, memberUserId);
    if (!row) {
      throw new NotFoundException({
        error_code: ErrorCode.RESOURCE_NOT_FOUND,
        message: 'The person is not a member of this company',
      });
    }

    // 1. Dates must name real calendar days (2026-02-30 is not one).
    const parsedDates = new Map<string, string | null | undefined>();
    for (const [dtoKey, column] of EMPLOYMENT_DATE_FIELDS) {
      const parsed = normalisedDate(dto[dtoKey]);
      if (
        parsed === null &&
        dto[dtoKey] !== null &&
        dto[dtoKey] !== undefined
      ) {
        throw new UnprocessableEntityException({
          error_code: ErrorCode.VALIDATION_ERROR,
          message: `${String(dtoKey)} is not a real calendar date — write it as YYYY-MM-DD`,
        });
      }
      parsedDates.set(column, parsed);
    }

    // 2. The employee code is permanent: null or blank is an attempted clear.
    const newCode = normalisedText(dto.employeeCode);
    if (newCode === null && dto.employeeCode !== undefined) {
      throw new UnprocessableEntityException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message:
          'The employee code is permanent — it can be edited but never removed',
      });
    }

    // 3. Exit rules on the post-write state.
    const resultJoin =
      parsedDates.get('join_date') === undefined
        ? row.join_date
        : (parsedDates.get('join_date') ?? null);
    const resultExit =
      parsedDates.get('exit_date') === undefined
        ? row.exit_date
        : (parsedDates.get('exit_date') ?? null);
    if (resultExit !== null && resultJoin === null) {
      throw new UnprocessableEntityException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message:
          'An exit date needs a joining date — set the joining date first',
      });
    }
    if (resultExit !== null && resultJoin !== null && resultExit < resultJoin) {
      throw new UnprocessableEntityException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'The exit date cannot be before the joining date',
      });
    }

    // The payload is built column by column — the body is never spread onto
    // the update, so a future DTO field cannot silently become a column write.
    const updates: Record<string, string | null> = {};
    const changedFields: string[] = [];
    const put = (column: keyof EmploymentRow, value: string | null) => {
      if (row[column] === value) return;
      updates[column] = value;
      changedFields.push(column);
    };

    if (newCode !== undefined && newCode !== row.employee_code) {
      updates['employee_code'] = newCode;
      changedFields.push('employee_code');
    }
    for (const [, column] of EMPLOYMENT_DATE_FIELDS) {
      const parsed = parsedDates.get(column);
      if (parsed !== undefined) put(column, parsed);
    }
    for (const [dtoKey, column] of EMPLOYMENT_TEXT_FIELDS) {
      const value = normalisedText(dto[dtoKey]);
      if (value !== undefined) put(column, value);
    }

    // A save that changes nothing writes no row and no audit entry.
    if (changedFields.length === 0) {
      return toEmploymentView(row);
    }

    // 4. A changed code must stay unique inside this company. The probe
    //    names the conflict; the unique-violation mapping below is the
    //    backstop for a race between the probe and the write.
    if (updates['employee_code'] !== undefined) {
      const { data: clash, error: probeError } = await admin
        .from('memberships')
        .select('user_id')
        .eq('tenant_id', tenantId)
        .eq('employee_code', updates['employee_code'])
        .maybeSingle<{ user_id: string }>();
      if (probeError) {
        this.logger.error('Failed to probe the employee code:', {
          error: probeError,
        });
        throw new InternalServerErrorException({
          error_code: ErrorCode.INTERNAL_SERVER_ERROR,
          message: 'Failed to save the employment record',
        });
      }
      if (clash && clash.user_id !== memberUserId) {
        throw new ConflictException({
          error_code: ErrorCode.DUPLICATE_RESOURCE,
          message: `Employee code ${updates['employee_code']} is already used by another member of your company`,
        });
      }
    }

    const { data: updated, error: updateError } = await admin
      .from('memberships')
      .update(updates)
      .eq('user_id', memberUserId)
      .eq('tenant_id', tenantId)
      .select(EMPLOYMENT_COLUMNS)
      .single<EmploymentRow>();
    if (updateError) {
      if (updateError.code === '23505') {
        throw new ConflictException({
          error_code: ErrorCode.DUPLICATE_RESOURCE,
          message: `Employee code ${updates['employee_code']} is already used by another member of your company`,
        });
      }
      if (updateError.code === 'PGRST116') {
        // The member was deleted between this read and the write.
        throw new NotFoundException({
          error_code: ErrorCode.RESOURCE_NOT_FOUND,
          message: 'The person is not a member of this company',
        });
      }
      if (updateError.code === '23514') {
        // A CHECK backstop tripped: another writer moved join/exit between
        // this read and the write.
        throw new ConflictException({
          error_code: ErrorCode.EMPLOYMENT_RECORD_CHANGED,
          message:
            'The employment record changed since it was read — reload and try again',
        });
      }
      this.logger.error('Failed to save the employment record:', {
        error: updateError,
      });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to save the employment record',
      });
    }

    // Audit: what changed, never the values behind it (no PAN, DOB or bank
    // details are copied into the log). A failed audit entry must not undo
    // the member's save, so both a resolved error and a rejection (network)
    // log and move on, like the import audit.
    try {
      const auditCall = (await admin.rpc('write_audit_row', {
        p_actor: caller.userId,
        p_action: 'member.employment_update',
        p_tenant_id: tenantId,
        p_target_user: memberUserId,
        p_details: {
          changed_fields: changedFields,
          old_employee_code: row.employee_code,
          new_employee_code: updated.employee_code,
        },
      })) as { error: { code?: string; message?: string } | null };
      if (auditCall.error) {
        this.logger.error('Failed to write the employment audit entry:', {
          error: auditCall.error,
        });
      }
    } catch (auditError: unknown) {
      this.logger.error('Failed to write the employment audit entry:', {
        error: auditError,
      });
    }

    return toEmploymentView(updated);
  }

  async setDisabled(
    caller: RequestUser,
    userId: string,
    disabled: boolean,
  ): Promise<{ userId: string; disabled: boolean }> {
    const { data, error } = await this.supabaseFactory
      .createAdmin()
      .rpc('set_user_disabled', {
        p_caller: caller.userId,
        p_user_id: userId,
        p_disabled: disabled,
      });
    if (error) {
      throw this.mapError(error, 'Failed to update the account');
    }
    return { userId, disabled: data === true };
  }

  /**
   * A company admin reads their own company's rows. A platform admin reads the
   * named company's rows (X-Company-Id), or every row when none is named.
   */
  async auditLog(
    caller: RequestUser,
    limit: number | undefined,
    before: string | undefined,
    beforeId?: string,
  ): Promise<AuditLogEntry[]> {
    if (beforeId && !before) {
      // The id only refines the timestamp cursor; alone it would be ignored.
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'beforeId needs before',
      });
    }
    let query = this.supabaseFactory
      .createAdmin()
      .from('audit_log')
      .select(
        'id, created_at, actor_user_id, actor_is_platform_admin, tenant_id, action, target_user_id, details',
      )
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit ?? DEFAULT_AUDIT_LIMIT);

    if (!caller.platformAdmin) {
      // Never trust the caller to widen this: a company admin always has a company.
      query = query.eq('tenant_id', caller.tenantId);
    } else if (caller.tenantId) {
      query = query.eq('tenant_id', caller.tenantId);
    }
    if (before) {
      // With beforeId the cursor is (created_at, id), so rows that share one
      // timestamp are never skipped. Both values are validated by the DTO
      // (ISO date, UUID) and quoted here.
      query = beforeId
        ? query.or(
            `created_at.lt."${before}",and(created_at.eq."${before}",id.lt.${beforeId})`,
          )
        : query.lt('created_at', before);
    }

    const { data, error } = await query;
    if (error) {
      this.logger.error('Failed to read the audit log:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to read the audit log',
      });
    }
    return (data ?? []).map((r) => ({
      id: r.id as string,
      createdAt: r.created_at as string,
      actorUserId: r.actor_user_id as string,
      actorIsPlatformAdmin: r.actor_is_platform_admin as boolean,
      tenantId: (r.tenant_id as string | null) ?? null,
      action: r.action as string,
      targetUserId: (r.target_user_id as string | null) ?? null,
      details: (r.details as Record<string, unknown>) ?? {},
    }));
  }

  private mapError(
    error: { code?: string; hint?: string | null; message?: string },
    fallback: string,
  ): Error {
    const mapped = memberRpcException(error);
    if (mapped) return mapped;
    this.logger.error(`${fallback}:`, { error });
    return new InternalServerErrorException({
      error_code: ErrorCode.INTERNAL_SERVER_ERROR,
      message: fallback,
    });
  }
}
