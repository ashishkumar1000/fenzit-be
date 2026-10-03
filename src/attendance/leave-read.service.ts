import { Injectable } from '@nestjs/common';
import { ErrorCode } from '../common/enums/error-code.enum';
import type { PoolClient } from 'pg';
import { PgPoolFactory } from '../common/pg/pg-pool.factory';
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
  LEAVE_MAX_SPAN_DAYS,
  REVOKE_SOURCE_STATES,
} from './leave.constants';
import {
  leaveNotFound,
  leaveRejectionToException,
  toRequestView,
  type LeaveActionPreview,
  type LeaveApplyPreview,
  type LeaveDayRow,
  type LeaveRequestView,
} from './leave.model';
import {
  findCheckedInDates,
  findDaysForRequests,
  findOverlappingDays,
  findRequestWithDays,
  listLeaveRequests,
  readEnrolmentFloor,
  readPageSpanFacts,
  readSettingsGate,
  readSpanFacts,
  type LeaveListRow,
} from './leave.repository';
import { findActiveOverrideDates } from './corrections.repository';
import {
  countWorkingDays,
  enumerateDates,
  nowMinuteIn,
  splitActionableDates,
  validateApplyFacts,
  validateApplyShape,
} from './leave-validation';
import { ApplyLeaveDto } from './dto/leave.dto';

const ME_LIST_SCOPE: CursorScope = 'leave-me-list';
const OWNER_LIST_SCOPE: CursorScope = 'leave-owner-list';
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

export interface LeaveListQuery {
  cursor?: string;
  limit?: number;
  status?: DerivedLeaveStatus;
  employeeId?: string;
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
  constructor(private readonly pg: PgPoolFactory) {}

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

  /** FR-17: the owner's list — `?status=pending` is the queue. */
  listForOwner(
    owner: RequestUser,
    query: LeaveListQuery,
  ): Promise<{
    data: LeaveRequestView[];
    nextCursor: string | null;
    hasMore: boolean;
  }> {
    const tenantId = requireTenant(owner);
    return this.pg.withTransaction((tx) =>
      this.listTransact(tx, tenantId, {
        employeeId: query.employeeId,
        status: query.status,
        cursor: query.cursor,
        limit: query.limit,
        scope: OWNER_LIST_SCOPE,
      }),
    );
  }

  // ---------------------------------------------------------------- apply

  private async previewApplyTransact(
    tx: PoolClient,
    tenantId: string,
    employeeId: string,
    dto: ApplyLeaveDto,
  ): Promise<LeaveApplyPreview> {
    const shape = validateApplyShape({
      startDate: dto.startDate,
      endDate: dto.endDate ?? dto.startDate,
      part: dto.part,
    });
    if (shape) {
      return { ok: false, errorCode: shape.errorCode, message: shape.message };
    }
    const dates = enumerateDates(dto.startDate, dto.endDate ?? dto.startDate);
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
    return {
      ok: true,
      workingDays: countWorkingDays(dates, spanFacts),
      totalDays: dates.length,
      part: dto.part,
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

  // ----------------------------------------------------------------- list

  private async listTransact(
    tx: PoolClient,
    tenantId: string,
    input: {
      employeeId?: string;
      status?: DerivedLeaveStatus;
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
      status: input.status,
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
      });
    }
    return { data, nextCursor, hasMore };
  }
}
