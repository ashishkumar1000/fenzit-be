import {
  Injectable,
  HttpException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ErrorCode } from '../common/enums/error-code.enum';
import type { PoolClient } from 'pg';
import { PgPoolFactory } from '../common/pg/pg-pool.factory';
import { readSubtreeMemberIds } from '../common/members/hierarchy';
import { readScopeFor } from '../common/permissions/permissions';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { decodeCursor, encodeCursor } from '../common/utils/cursor.util';
import type { CursorScope } from '../common/utils/cursor.util';
import { requireTenant } from './attendance-rpc.helpers';
import { dbNow } from './check-in-out.repository';
import { tenantToday } from './enrolments.repository';
import { buildDayContext } from './day-context.read';
import { isoWeekdayOf } from '../common/day-status/day-context';
import { pickWeeklyOffDays } from './me-summary.model';
import {
  CANCEL_SOURCE_STATES,
  type DerivedLeaveStatus,
  REVOKE_SOURCE_STATES,
} from './leave.constants';
import {
  leaveNotFound,
  toRequestView,
  type LeaveActionPreview,
  type LeaveApplyPreview,
  type LeaveDayRow,
  type LeaveRejection,
  type LeaveRequestView,
} from './leave.model';
import {
  countActiveEmployees,
  countLeaveRequestsByStatus,
  findAvailableColleagues,
  findCheckedInDates,
  findDaysForRequests,
  findOfficeAssignment,
  findOfficeNames,
  findOverlappingDays,
  findRequestWithDays,
  listLeaveRequests,
  readEnrolmentFloor,
  readLeaveTypeConfig,
  readPageSpanFacts,
  readSettingsGate,
  readSpanFacts,
  type AvailableColleague,
  type LeaveListRow,
} from './leave.repository';
import { assertBalanceForApply } from './leave-balance.service';
import type { AccrualTypeConfig } from './leave-balance.math';
import { assertPayrollDatesEditable } from './payroll-date-gate';
import { findActiveOverrideDates } from './corrections.repository';
import {
  countWorkingDays,
  enumerateDates,
  nowMinuteIn,
  splitActionableDates,
  validateApplyFacts,
  validateApplyShape,
} from './leave-validation';
import { ApplyLeaveDto, OnBehalfPreviewQueryDto } from './dto/leave.dto';
import {
  avatarUrlFor,
  presignAvatarUrls,
} from '../common/members/member-avatars';
import { StorageService } from '../storage/storage.service';

const ME_LIST_SCOPE: CursorScope = 'leave-me-list';
const OWNER_LIST_SCOPE: CursorScope = 'leave-owner-list';
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

export interface LeaveListQuery {
  cursor?: string;
  limit?: number;
  status?: DerivedLeaveStatus;
  employeeId?: string;
  /** Overlap-window start (owner list, 27-1): end_date >= from. */
  from?: string;
  /** Overlap-window end (owner list, 27-1): start_date <= to; from <= to. */
  to?: string;
  /** Free-text needle over person/code/reason (owner list only). */
  q?: string;
}

/**
 * The leave reads (17-1..17-4): previews share the writes' validation and
 * split paths (AD-24/D4 — no re-implementation exists), lists derive
 * status and working days on read (D5). Previews run the same access gate
 * as their writes; an action preview with nothing actionable answers 200
 * with empty actionDates (previews never 409 — D13).
 */
@Injectable()
export class LeaveReadService {
  constructor(
    private readonly pg: PgPoolFactory,
    private readonly storageService: StorageService,
  ) {}

  /** 17-5's live working-day count — the apply validation, persist:false. */
  previewApply(
    user: RequestUser,
    dto: ApplyLeaveDto,
  ): Promise<LeaveApplyPreview> {
    const tenantId = requireTenant(user);
    return this.pg.withTransaction((tx) =>
      this.previewApplyTransact(tx, tenantId, user.userId, dto),
    );
  }

  /** 23-14: the owner's on-behalf apply preview — the same validation the
   *  on-behalf POST runs (persist:false) for a PROPOSED spend on the
   *  chosen employee. The apply-on-behalf form has no technician-scoped
   *  `me` preview (the owner JWT answers 403 there), so this route is
   *  what lets that form catch a rejection (insufficient balance, locked
   *  month, overlap) at pick time instead of as a submit 422. */
  previewApplyOnBehalf(
    owner: RequestUser,
    dto: OnBehalfPreviewQueryDto,
  ): Promise<LeaveApplyPreview> {
    const tenantId = requireTenant(owner);
    return this.pg.withTransaction((tx) =>
      this.previewApplyTransact(tx, tenantId, dto.employeeId, dto),
    );
  }

  /** 17-3: the employee's cancel split (17-7 renders from it). */
  previewCancel(
    user: RequestUser,
    leaveRequestId: string,
  ): Promise<LeaveActionPreview> {
    const tenantId = requireTenant(user);
    return this.pg.withTransaction((tx) =>
      this.previewActionTransact(
        tx,
        tenantId,
        user.userId,
        leaveRequestId,
        'cancel',
      ),
    );
  }

  /** 17-3: the owner's revoke split (17-7 renders from it). */
  previewRevoke(
    owner: RequestUser,
    leaveRequestId: string,
  ): Promise<LeaveActionPreview> {
    const tenantId = requireTenant(owner);
    return this.pg.withTransaction((tx) =>
      this.previewActionTransact(
        tx,
        tenantId,
        owner.userId,
        leaveRequestId,
        'revoke',
      ),
    );
  }

  /** FR-17: the employee's own history (scope-contained cursor). */
  listMine(
    user: RequestUser,
    query: LeaveListQuery,
  ): Promise<{
    data: LeaveRequestView[];
    nextCursor: string | null;
    hasMore: boolean;
  }> {
    const tenantId = requireTenant(user);
    return this.pg.withTransaction((tx) =>
      this.listTransact(tx, tenantId, {
        employeeId: user.userId,
        status: query.status,
        cursor: query.cursor,
        limit: query.limit,
        scope: ME_LIST_SCOPE,
      }),
    );
  }

  /** FR-17: the owner's list — `?status=pending` is the queue; the 27-1
   *  `from`/`to` pair bounds it to requests OVERLAPPING the window (the
   *  calendar's month read). Both window checks run here, before the
   *  transaction — a doomed call never opens one: the pair must be sent
   *  together (a lone edge is not the documented [from, to] window), and
   *  from <= to. */
  listForOwner(
    owner: RequestUser,
    query: LeaveListQuery,
  ): Promise<{
    data: LeaveRequestView[];
    nextCursor: string | null;
    hasMore: boolean;
  }> {
    const tenantId = requireTenant(owner);
    if ((query.from && !query.to) || (query.to && !query.from)) {
      throw new UnprocessableEntityException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'from and to must be sent together',
      });
    }
    if (query.from && query.to && query.from > query.to) {
      throw new UnprocessableEntityException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'from must be on or before to',
      });
    }
    return this.pg.withTransaction(async (tx) => {
      const employeeIds = await this.scopedEmployeeIds(
        tx,
        owner,
        tenantId,
        query.employeeId,
      );
      return this.listTransact(tx, tenantId, {
        employeeId: query.employeeId,
        // A named id is already validated inside the scope, so the array
        // predicate would be redundant (and adds nothing to the plan).
        employeeIds: query.employeeId ? undefined : employeeIds,
        status: query.status,
        from: query.from,
        to: query.to,
        q: query.q,
        cursor: query.cursor,
        limit: query.limit,
        scope: OWNER_LIST_SCOPE,
      });
    });
  }

  /**
   * The employees a team read may touch (24-2/CAP-2): `undefined` for a
   * whole-company caller, otherwise self plus the manager's subtree. A member
   * with no reports keeps today's refusal (403); an explicitly named employee
   * outside the subtree answers the same 404 as a missing one.
   */
  private async scopedEmployeeIds(
    tx: PoolClient,
    user: RequestUser,
    tenantId: string,
    requestedEmployeeId?: string,
  ): Promise<string[] | undefined> {
    if (readScopeFor(user.role, 'leave.read_all') === 'tenant') {
      return undefined;
    }
    const descendants = await readSubtreeMemberIds(tx, tenantId, user.userId);
    if (descendants.length === 0) {
      // Today's guard answer, verbatim: a member without reports must see no
      // new surface for this route (CAP-2).
      throw new ForbiddenException({
        error_code: ErrorCode.FORBIDDEN,
        message: 'Insufficient permissions',
      });
    }
    const allowed = [user.userId, ...descendants];
    if (
      requestedEmployeeId &&
      !allowed.some(
        (id) => id.toLowerCase() === requestedEmployeeId.toLowerCase(),
      )
    ) {
      // Postgres compares uuids case-insensitively; so does the scope check.
      throw new NotFoundException({
        error_code: ErrorCode.RESOURCE_NOT_FOUND,
        message: 'Not found',
      });
    }
    return allowed;
  }

  // ---------------------------------------------------------------- apply

  /** Reverse-map a write-path gate exception (they all carry
   *  `{error_code, message}`) into the preview's inline rejection — the
   *  preview answers the SAME verdict the POST would, as 200 (D13:
   *  previews never 404/422). */
  private rejectionFromException(error: unknown): LeaveRejection {
    const response =
      error instanceof HttpException ? error.getResponse() : null;
    if (
      response &&
      typeof response === 'object' &&
      'error_code' in response &&
      'message' in response
    ) {
      return {
        errorCode: (response as { error_code: ErrorCode }).error_code,
        message: String((response as { message: unknown }).message),
      };
    }
    return {
      errorCode: ErrorCode.VALIDATION_ERROR,
      message: 'This request cannot be applied for',
    };
  }

  private async previewApplyTransact(
    tx: PoolClient,
    tenantId: string,
    employeeId: string,
    // The apply-preview's input slice — the wire fields the validation
    // reads (the write DTO carries `reason` too; a preview never needs
    // it). Both the me query and the on-behalf query satisfy this.
    dto: {
      startDate: string;
      endDate?: string;
      part?: 'full_day' | 'first_half' | 'second_half';
      leaveTypeId?: string | null;
    },
  ): Promise<LeaveApplyPreview> {
    const part = dto.part ?? 'full_day';
    // CAP-12 first — the write path validates a named type before
    // anything else, so the preview's verdict precedence matches it
    // exactly (23-14: a disabled row or a foreign id answers inline).
    let balanceType: AccrualTypeConfig | null = null;
    if (dto.leaveTypeId) {
      const type = await readLeaveTypeConfig(tx, tenantId, dto.leaveTypeId);
      if (!type) {
        // The write path 404s (RESOURCE_NOT_FOUND, "The leave type is not
        // in this company") — previews never 404 (D13), so the same
        // verdict rides the inline rejection instead.
        return {
          ok: false,
          errorCode: ErrorCode.RESOURCE_NOT_FOUND,
          message: 'The leave type is not in this company',
        };
      }
      if (type.code === null || !type.enabled) {
        return {
          ok: false,
          errorCode: ErrorCode.LEAVE_TYPE_DISABLED,
          message: 'This leave type is no longer available to apply for',
        };
      }
      balanceType = type;
    }
    const shape = validateApplyShape({
      startDate: dto.startDate,
      endDate: dto.endDate ?? dto.startDate,
      part,
    });
    if (shape) {
      return { ok: false, errorCode: shape.errorCode, message: shape.message };
    }
    const dates = enumerateDates(dto.startDate, dto.endDate ?? dto.startDate);
    // The write path's payroll-lock gate (23-7 follow-up): a locked month
    // is final, so its answer outranks the eligibility facts — catch it
    // here too, as the same plain-English message the POST would 422
    // with (23-14: catch the mistake at pick time, not at submit).
    try {
      await assertPayrollDatesEditable(tx, tenantId, dates);
    } catch (error) {
      const rejection = this.rejectionFromException(error);
      return { ok: false, ...rejection };
    }
    const today = await tenantToday(tx, tenantId);
    const [
      enrolment,
      settings,
      spanFacts,
      overlapping,
      checkedIn,
      overrideDates,
    ] = await Promise.all([
      readEnrolmentFloor(tx, employeeId, today),
      readSettingsGate(tx, tenantId),
      readSpanFacts(
        tx,
        tenantId,
        employeeId,
        dates,
        pickWeeklyOffDays,
        isoWeekdayOf,
      ),
      findOverlappingDays(
        tx,
        tenantId,
        employeeId,
        dates[0],
        dates[dates.length - 1],
      ),
      findCheckedInDates(
        tx,
        tenantId,
        employeeId,
        dates[0],
        dates[dates.length - 1],
        today,
      ),
      findActiveOverrideDates(tx, {
        tenantId,
        employeeId,
        start: dates[0],
        end: dates[dates.length - 1],
      }),
    ]);
    const rejection = validateApplyFacts(dates, {
      today,
      enrolment,
      settings,
      spanFacts,
      overlappingDates: overlapping.map((d) => d.leave_date),
      checkedInDates: checkedIn,
      overrideDates,
    });
    if (rejection) {
      return {
        ok: false,
        errorCode: rejection.errorCode,
        message: rejection.message,
      };
    }
    // 23-13's balance check (reads only — the write path holds the
    // per-employee advisory lock around it because it then WRITES): the
    // preview answers the exact insufficient-balance message the POST
    // would 422 with, so neither form ever submits a known-refused
    // request.
    if (balanceType) {
      try {
        await assertBalanceForApply(
          tx,
          tenantId,
          employeeId,
          balanceType,
          dates,
          part,
          spanFacts,
          today,
        );
      } catch (error) {
        const balanceRejection = this.rejectionFromException(error);
        return { ok: false, ...balanceRejection };
      }
    }
    return {
      ok: true,
      workingDays: countWorkingDays(dates, spanFacts),
      totalDays: dates.length,
      part,
      dates: dates.map((date) => {
        const fact = spanFacts.get(date)!;
        return { date, isWorkingDay: fact.isWorkingDay, kind: fact.kind };
      }),
    };
  }

  // --------------------------------------------------------------- action

  private async previewActionTransact(
    tx: PoolClient,
    tenantId: string,
    callerId: string,
    leaveRequestId: string,
    action: 'revoke' | 'cancel',
  ): Promise<LeaveActionPreview> {
    const found = await findRequestWithDays(
      tx,
      tenantId,
      leaveRequestId,
      action === 'cancel' ? callerId : undefined,
    );
    if (!found) throw leaveNotFound();
    const { request, days } = found;
    const sourceStates =
      action === 'revoke' ? REVOKE_SOURCE_STATES : CANCEL_SOURCE_STATES;
    const sourceDays = days.filter((d) => sourceStates.includes(d.state));
    const today = await tenantToday(tx, tenantId);
    const ctx = await buildDayContext(
      tx,
      tenantId,
      request.employee_id,
      today,
      false,
    );
    const now = await dbNow(tx);
    const split = splitActionableDates(sourceDays, {
      today,
      nowMinute: nowMinuteIn(ctx.timezone, now),
      startMinute: ctx.startMinute,
      sourceStates,
    });
    const spanFacts = await readSpanFacts(
      tx,
      tenantId,
      request.employee_id,
      enumerateDates(request.start_date, request.end_date),
      pickWeeklyOffDays,
      isoWeekdayOf,
    );
    return {
      action,
      actionDates: split.actionDates,
      keepDates: split.keepDates,
      request: toRequestView(
        request,
        days,
        countWorkingDays(
          days.map((d) => d.leave_date),
          spanFacts,
        ),
      ),
    };
  }

  /** The calendar rail's team-size fact plus the requests tab's pill
   *  counts, in one read: this company's active employees, and the whole
   *  tenant's request counts by derived status (the same CASE the list
   *  filters with — a pill's number can never disagree with its filter). */
  async readSummary(owner: RequestUser): Promise<{
    activeEmployees: number;
    counts: Record<DerivedLeaveStatus, number>;
  }> {
    const tenantId = requireTenant(owner);
    return this.pg.withTransaction(async (tx) => ({
      activeEmployees: await countActiveEmployees(tx, tenantId),
      counts: await countLeaveRequestsByStatus(tx, tenantId),
    }));
  }

  /** The requests tab's coverage check: who else is available while this
   *  requester is out. The span is the REQUEST's own, and everything
   *  date-anchored reads the span's FIRST day — an upcoming leave after a
   *  planned transfer answers the office the leave starts under, not
   *  today's. The roster is the active employees at that office
   *  (company-wide when the person has none there), each holding no
   *  pending-or-approved day inside the span; a SINGLE-day span also drops
   *  colleagues whose day is a weekly off or holiday, so "available"
   *  reads "actually working that day" exactly where the card's line
   *  names someone on duty. */
  async readCoverage(
    owner: RequestUser,
    leaveRequestId: string,
  ): Promise<{
    officeName: string | null;
    availableCount: number;
    onDutyName: string | null;
    anchorDate: string;
  }> {
    const tenantId = requireTenant(owner);
    return this.pg.withTransaction(async (tx) => {
      // Resolve the scope BEFORE the request read: a caller with no reports
      // must get the same 403 whether or not the id exists, so the refusal
      // cannot become an existence oracle.
      const employeeIds = await this.scopedEmployeeIds(tx, owner, tenantId);
      const found = await findRequestWithDays(tx, tenantId, leaveRequestId);
      if (!found) throw leaveNotFound();
      // A manager reaches coverage only for their own team; another branch's
      // request answers exactly like a missing one (CAP-2, no existence leak).
      if (employeeIds && !employeeIds.includes(found.request.employee_id)) {
        throw leaveNotFound();
      }
      const anchor = found.request.start_date;
      const office = await findOfficeAssignment(
        tx,
        tenantId,
        found.request.employee_id,
        anchor,
      );
      const colleagues = await findAvailableColleagues(tx, {
        tenantId,
        excludeEmployeeId: found.request.employee_id,
        anchor,
        officeId: office?.officeId ?? null,
        start: found.request.start_date,
        end: found.request.end_date,
      });
      const roster =
        found.request.start_date === found.request.end_date
          ? await this.workingThatDay(
              tx,
              tenantId,
              colleagues,
              found.request.start_date,
            )
          : colleagues;
      return {
        officeName: office?.officeName ?? null,
        availableCount: roster.length,
        // users.name is nullable and PG sorts an empty string FIRST among
        // names — pair with the first colleague whose name is a real name
        // (truthiness, not a null check) so neither null nor '' ever
        // surfaces as a blank on-duty name.
        onDutyName: roster.find((c) => c.name)?.name ?? null,
        anchorDate: anchor,
      };
    });
  }

  /** Single-day spans only: the leave-free roster minus whoever is on a
   *  weekly off or holiday that day — the list page's own batched span
   *  facts (3 statements for the whole roster, the 17s-page lesson's
   *  machinery). A member with no fact row stays IN: the filter only ever
   *  proves someone OFF, never invents an absence. */
  private async workingThatDay(
    tx: PoolClient,
    tenantId: string,
    colleagues: AvailableColleague[],
    date: string,
  ): Promise<AvailableColleague[]> {
    if (colleagues.length === 0) return colleagues;
    const facts = await readPageSpanFacts(
      tx,
      tenantId,
      colleagues.map((c) => ({ employeeId: c.id, dates: [date] })),
      pickWeeklyOffDays,
      isoWeekdayOf,
    );
    return colleagues.filter(
      (c) => facts.get(c.id)?.get(date)?.isWorkingDay !== false,
    );
  }

  // ----------------------------------------------------------------- list

  private async listTransact(
    tx: PoolClient,
    tenantId: string,
    input: {
      employeeId?: string;
      /** Manager team scope (self + subtree); admins leave it undefined. */
      employeeIds?: string[];
      status?: DerivedLeaveStatus;
      from?: string;
      to?: string;
      q?: string;
      cursor?: string;
      limit?: number;
      scope: CursorScope;
    },
  ): Promise<{
    data: LeaveRequestView[];
    nextCursor: string | null;
    hasMore: boolean;
  }> {
    const pageSize = Math.min(
      Math.max(input.limit ?? DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE,
    );
    let cursorCreatedAt: string | undefined;
    let cursorId: string | undefined;
    if (input.cursor) {
      const decoded = decodeCursor(input.cursor, input.scope); // 400 on foreign scope
      cursorCreatedAt = decoded.createdAt;
      cursorId = decoded.id;
    }
    const rows: LeaveListRow[] = await listLeaveRequests(tx, {
      tenantId,
      employeeId: input.employeeId,
      employeeIds: input.employeeIds,
      status: input.status,
      from: input.from,
      to: input.to,
      q: input.q,
      cursorCreatedAt,
      cursorId,
      limit: pageSize,
    });
    const hasMore = rows.length > pageSize;
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
    const last = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor(
            last.id,
            new Date(last.created_at).toISOString(),
            input.scope,
          )
        : null;

    const daysByRequest = await findDaysForRequests(
      tx,
      pageRows.map((r) => r.id),
    );
    // The page's span facts in ONE batched read. The per-row readSpanFacts
    // loop cost 3 strictly-sequential round trips per row (one tx
    // connection cannot pipeline) — ~17s for a 20-row page on the pooler,
    // past the client's 15s timeout; the batch is 3 round trips per page.
    const factsByEmployee = await readPageSpanFacts(
      tx,
      tenantId,
      pageRows.map((row) => ({
        employeeId: row.employee_id,
        dates: enumerateDates(row.start_date, row.end_date),
      })),
      pickWeeklyOffDays,
      isoWeekdayOf,
    );
    const avatarUrls = await presignAvatarUrls(
      this.storageService,
      pageRows.map((r) => r.avatar_key),
    );
    // The office line is an owner-list concern (the timeline card's
    // "EMP-1015 • Office") — one batched read keyed by the tenant's today,
    // never a join into the keyset query.
    const officeNames =
      input.scope === OWNER_LIST_SCOPE
        ? await findOfficeNames(
            tx,
            tenantId,
            pageRows.map((row) => row.employee_id),
            await tenantToday(tx, tenantId),
          )
        : null;
    const data: LeaveRequestView[] = [];
    for (const row of pageRows) {
      const days: LeaveDayRow[] = daysByRequest.get(row.id) ?? [];
      // The facts map is keyed by the same employee_ids as pageRows, so a
      // miss can only be a wiring bug — fail loudly instead of silently
      // answering an empty-facts workingDays of 0 on every row.
      const spanFacts = factsByEmployee.get(row.employee_id);
      if (!spanFacts) {
        throw new Error(`span facts missing for employee ${row.employee_id}`);
      }
      data.push({
        ...toRequestView(
          row,
          days,
          countWorkingDays(
            days.map((d) => d.leave_date),
            spanFacts,
          ),
        ),
        status: row.derived_status,
        employeeName: row.employee_name ?? undefined,
        employeeCode: row.employee_code ?? undefined,
        leaveTypeId: row.leave_type_id ?? undefined,
        leaveTypeCode: row.leave_type_code ?? undefined,
        leaveTypeName: row.leave_type_name ?? undefined,
        officeName: officeNames?.get(row.employee_id) ?? undefined,
        employeeAvatarUrl: avatarUrlFor(avatarUrls, row.avatar_key),
      });
    }
    return { data, nextCursor, hasMore };
  }
}
