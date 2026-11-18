import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { PgPoolFactory } from '../common/pg/pg-pool.factory';
import { ErrorCode } from '../common/enums/error-code.enum';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { internalError, requireTenant } from './attendance-rpc.helpers';
import { dbNow } from './check-in-out.repository';
import { readCompanyAdminIds } from './company-admins';
import { lockTenantShared, tenantToday } from './enrolments.repository';
import { buildDayContext } from './day-context.read';
import { isoWeekdayOf } from '../common/day-status/day-context';
import { pickWeeklyOffDays } from './me-summary.model';
import {
  CANCEL_SOURCE_STATES,
  type LeaveCause,
  type LeaveDayState,
  PENDING_SOURCE_STATES,
  REVOKE_SOURCE_STATES,
} from './leave.constants';
import {
  leaveDuplicateKey,
  leaveEmployeeNotFound,
  leaveNotFound,
  leaveRejectionToException,
  leaveTypeNotFound,
  toRequestView,
  type LeaveRequestView,
} from './leave.model';
import {
  findCheckedInDates,
  findDaysInStates,
  findLastEvent,
  findOverlappingDays,
  findRequestWithDays,
  findRequestIdByKey,
  insertLeaveRequest,
  employeeExistsInTenant,
  readLeaveTypeConfig,
  readEnrolmentFloor,
  readEmployeeName,
  readSettingsGate,
  readSpanFacts,
} from './leave.repository';
import { assertBalanceForApply } from './leave-balance.service';
import type { AccrualTypeConfig } from './leave-balance.math';
import { findActiveOverrideDates } from './corrections.repository';
import { assertPayrollDatesEditable } from './payroll-date-gate';
import {
  insertInitialLeaveDays,
  transitionLeaveDays,
} from './leave-transition';
import {
  countWorkingDays,
  enumerateDates,
  nowMinuteIn,
  splitActionableDates,
  validateApplyFacts,
  validateApplyShape,
} from './leave-validation';
import { ApplyLeaveDto, OnBehalfLeaveDto } from './dto/leave.dto';

/**
 * The leave lifecycle writes (17-1..17-4): one pg transaction per call
 * (the 15-7/16-1 pattern — zero new SQL functions beyond the guard
 * trigger, AD-3 amendment), AD-5 lock order (shared tenant → exclusive
 * employee), decide-read UNDER the lock (spec D2), AD-6 caller-scoped
 * idempotency for apply/on-behalf and state-guarded actions for
 * approve/reject/revoke/cancel. Unlike check-in/out there are no
 * committed-attempt rows, so a validation rejection throws INSIDE the
 * transaction and rolls back — nothing needs to survive it.
 */
@Injectable()
export class LeaveService {
  private readonly logger = new Logger(LeaveService.name);

  constructor(private readonly pg: PgPoolFactory) {}

  /** 17-1: the employee applies for themselves (AD-6 idempotency key). */
  applyForSelf(
    user: RequestUser,
    dto: ApplyLeaveDto,
    requestId: string,
  ): Promise<LeaveRequestView> {
    const tenantId = requireTenant(user);
    return this.pg.withTransaction((tx) =>
      this.applyTransact(tx, {
        tenantId,
        employeeId: user.userId,
        callerId: user.userId,
        dto,
        requestId,
        onBehalf: false,
      }),
    );
  }

  /** 17-4 (FR-16): the owner applies FOR an employee — approved immediately. */
  applyOnBehalf(
    owner: RequestUser,
    dto: OnBehalfLeaveDto,
    requestId: string,
  ): Promise<LeaveRequestView> {
    const tenantId = requireTenant(owner);
    return this.pg.withTransaction((tx) =>
      this.applyTransact(tx, {
        tenantId,
        employeeId: dto.employeeId,
        callerId: owner.userId,
        dto,
        requestId,
        onBehalf: true,
      }),
    );
  }

  /** 17-2: owner approves — all pending days of the request. */
  approve(
    owner: RequestUser,
    leaveRequestId: string,
  ): Promise<LeaveRequestView> {
    const tenantId = requireTenant(owner);
    return this.pg.withTransaction((tx) =>
      this.actTransact(tx, tenantId, owner.userId, leaveRequestId, {
        sourceStates: PENDING_SOURCE_STATES,
        toState: 'approved',
        cause: 'approve',
        conflictCode: ErrorCode.LEAVE_NOT_PENDING,
        conflictMessage: 'This request is no longer pending',
        reason: null,
      }),
    );
  }

  /** 17-2: owner rejects — reason optional (FR-13). */
  reject(
    owner: RequestUser,
    leaveRequestId: string,
    reason: string | null,
  ): Promise<LeaveRequestView> {
    const tenantId = requireTenant(owner);
    return this.pg.withTransaction((tx) =>
      this.actTransact(tx, tenantId, owner.userId, leaveRequestId, {
        sourceStates: PENDING_SOURCE_STATES,
        toState: 'rejected',
        cause: 'reject',
        conflictCode: ErrorCode.LEAVE_NOT_PENDING,
        conflictMessage: 'This request is no longer pending',
        reason,
      }),
    );
  }

  /** 17-3 (FR-14): owner revokes the not-yet-started approved days. */
  revoke(
    owner: RequestUser,
    leaveRequestId: string,
    reason: string,
  ): Promise<LeaveRequestView> {
    const tenantId = requireTenant(owner);
    return this.pg.withTransaction((tx) =>
      this.actTransact(tx, tenantId, owner.userId, leaveRequestId, {
        sourceStates: REVOKE_SOURCE_STATES,
        toState: 'revoked',
        cause: 'owner_revoke',
        conflictCode: ErrorCode.LEAVE_NOT_REVOKABLE,
        conflictMessage: 'No future dates left to revoke',
        reason,
      }),
    );
  }

  /** 17-3 (FR-15): employee cancels their not-yet-started days. */
  cancel(user: RequestUser, leaveRequestId: string): Promise<LeaveRequestView> {
    const tenantId = requireTenant(user);
    return this.pg.withTransaction((tx) =>
      this.cancelTransact(tx, tenantId, user.userId, leaveRequestId),
    );
  }

  // ---------------------------------------------------------------- apply

  private async applyTransact(
    tx: PoolClient,
    input: {
      tenantId: string;
      employeeId: string;
      callerId: string;
      dto: ApplyLeaveDto;
      requestId: string;
      onBehalf: boolean;
    },
  ): Promise<LeaveRequestView> {
    await lockTenantShared(tx, input.tenantId);
    // D10: a foreign on-behalf target answers 404 before the gate — no
    // existence leak, and never an ATTENDANCE_NOT_TRACKED for a person
    // who was never in this tenant.
    if (input.onBehalf) {
      const exists = await employeeExistsInTenant(
        tx,
        input.tenantId,
        input.employeeId,
      );
      if (!exists) throw leaveEmployeeNotFound();
    }
    await tx.query('select public.attendance_lock_employee($1)', [
      input.employeeId,
    ]);
    const today = await tenantToday(tx, input.tenantId);

    // AD-6 replay — caller-scoped (spec D7): another caller presenting a
    // burned key neither reads this request nor is blocked by it.
    const replay = await findRequestIdByKey(
      tx,
      input.tenantId,
      input.requestId,
      input.callerId,
    );
    if (replay) {
      return this.buildView(tx, input.tenantId, replay);
    }

    // CAP-12: a named catalog type must belong to this company; absent or
    // null keeps the request untyped, which reads as paid. 23-13: a
    // disabled row or a legacy remnant cannot carry a new request.
    let leaveTypeId: string | null = null;
    let balanceType: AccrualTypeConfig | null = null;
    if (input.dto.leaveTypeId) {
      const type = await readLeaveTypeConfig(
        tx,
        input.tenantId,
        input.dto.leaveTypeId,
      );
      if (!type) throw leaveTypeNotFound();
      if (type.code === null || !type.enabled) {
        throw leaveRejectionToException({
          errorCode: ErrorCode.LEAVE_TYPE_DISABLED,
          message: 'This leave type is no longer available to apply for',
        });
      }
      leaveTypeId = input.dto.leaveTypeId;
      balanceType = type;
    }

    const shape = validateApplyShape({
      startDate: input.dto.startDate,
      endDate: input.dto.endDate ?? input.dto.startDate,
      part: input.dto.part,
    });
    if (shape) throw leaveRejectionToException(shape);

    const dates = enumerateDates(
      input.dto.startDate,
      input.dto.endDate ?? input.dto.startDate,
    );

    // 23-7 follow-up: the lock gate BEFORE the eligibility facts. A locked
    // month is final, so its answer outranks the apply-window rules (and
    // keeps the e2e answer stable against real-date drift). Both requesters
    // are gated: an on-behalf apply writes approved days straight away, and
    // a pending day on a frozen date could never be approved later either.
    // The AD-6 replay check above has already returned, so replaying an
    // apply that predates the lock still answers with its own request.
    await assertPayrollDatesEditable(tx, input.tenantId, dates);
    const [
      enrolment,
      settings,
      spanFacts,
      overlapping,
      checkedIn,
      overrideDates,
    ] = await Promise.all([
      readEnrolmentFloor(tx, input.employeeId, today),
      readSettingsGate(tx, input.tenantId),
      readSpanFacts(
        tx,
        input.tenantId,
        input.employeeId,
        dates,
        pickWeeklyOffDays,
        isoWeekdayOf,
      ),
      findOverlappingDays(
        tx,
        input.tenantId,
        input.employeeId,
        dates[0],
        dates[dates.length - 1],
      ),
      findCheckedInDates(
        tx,
        input.tenantId,
        input.employeeId,
        dates[0],
        dates[dates.length - 1],
        today,
      ),
      findActiveOverrideDates(tx, {
        tenantId: input.tenantId,
        employeeId: input.employeeId,
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
    if (rejection) throw leaveRejectionToException(rejection);

    // 23-13: the balance check, still under the per-employee advisory lock
    // — pending days debit immediately, so the check sees exactly what the
    // approval would keep. Per-FY segment, off days carry no debit, and a
    // type that allows over-balance (and mode-none/untyped applies) skips
    // it entirely.
    if (balanceType) {
      await assertBalanceForApply(
        tx,
        input.tenantId,
        input.employeeId,
        balanceType,
        dates,
        input.dto.part,
        spanFacts,
        today,
      );
    }

    const request = await insertLeaveRequest(tx, {
      tenantId: input.tenantId,
      employeeId: input.employeeId,
      requestId: input.requestId,
      startDate: input.dto.startDate,
      endDate: input.dto.endDate ?? input.dto.startDate,
      part: input.dto.part,
      reason: input.dto.reason.trim(),
      createdBy: input.callerId,
      leaveTypeId,
    });
    if (request === 'duplicate_key') {
      // The key raced a DIFFERENT caller's insert — no second row (D7).
      throw leaveDuplicateKey();
    }

    const workingDays = countWorkingDays(dates, spanFacts);
    const employeeName = await readEmployeeName(
      tx,
      input.tenantId,
      input.employeeId,
    );
    const notification = input.onBehalf
      ? {
          recipientIds: [input.employeeId],
          payload: {
            startDate: request.start_date,
            endDate: request.end_date,
            workingDays,
          },
        }
      : await this.ownerNotification(tx, input.tenantId, {
          payload: {
            employeeName,
            startDate: request.start_date,
            endDate: request.end_date,
            workingDays,
          },
        });
    await insertInitialLeaveDays(tx, {
      tenantId: input.tenantId,
      employeeId: input.employeeId,
      requestId: input.requestId,
      leaveRequestDbId: request.id,
      cause: input.onBehalf ? 'apply_on_behalf' : 'apply',
      actorId: input.callerId,
      reason: input.dto.reason.trim(),
      dates,
      initialState: input.onBehalf ? 'approved' : 'pending',
      notification,
    });
    return this.buildView(tx, input.tenantId, request);
  }

  // -------------------------------------------- approve / reject / revoke

  private async actTransact(
    tx: PoolClient,
    tenantId: string,
    actorId: string,
    leaveRequestId: string,
    config: {
      sourceStates: LeaveDayState[];
      toState: 'approved' | 'rejected' | 'revoked';
      cause: 'approve' | 'reject' | 'owner_revoke';
      conflictCode: ErrorCode;
      conflictMessage: string;
      reason: string | null;
    },
  ): Promise<LeaveRequestView> {
    const found = await findRequestWithDays(tx, tenantId, leaveRequestId);
    if (!found) throw leaveNotFound();
    const { request } = found;
    await lockTenantShared(tx, tenantId);
    await tx.query('select public.attendance_lock_employee($1)', [
      request.employee_id,
    ]);
    const today = await tenantToday(tx, tenantId);

    // Re-read the actionable days UNDER the lock (decide-read-act atomic).
    const sourceDays = await findDaysInStates(
      tx,
      request.id,
      config.sourceStates,
    );

    let actionDates = sourceDays.map((d) => d.leave_date);
    if (config.cause === 'owner_revoke') {
      const split = await this.splitForRequest(
        tx,
        tenantId,
        request.employee_id,
        today,
        sourceDays,
        config.sourceStates,
      );
      actionDates = split.actionDates;
    }
    if (sourceDays.length === 0 || actionDates.length === 0) {
      const last = await findLastEvent(tx, request.id);
      if (last?.cause === config.cause && last.actorId === actorId) {
        return this.buildView(tx, tenantId, request); // AD-6 own retry
      }
      throw leaveRejectionToException({
        errorCode: config.conflictCode,
        message: config.conflictMessage,
      });
    }

    // 23-7 follow-up: approving (or revoking) a frozen date would rewrite
    // the input a locked month's run already consumed — refuse like a
    // frozen correction does. reject is deliberately UNGATED: a pending day
    // never fed the run, so rejecting it keeps the queue clean without
    // touching frozen payslip input (the disable sweep's past-pending
    // cancel is accepted on the same grounds). revoke's actionable dates
    // are today-or-future, so its gate only fires under a same-day run+lock
    // (the run opens on the cut-off day) — the backstop, not the norm.
    if (config.cause === 'approve' || config.cause === 'owner_revoke') {
      await assertPayrollDatesEditable(tx, tenantId, actionDates);
    }

    const notification =
      config.cause === 'approve' ||
      config.cause === 'reject' ||
      config.cause === 'owner_revoke'
        ? await this.notificationFor(
            tx,
            tenantId,
            config.cause,
            request,
            actionDates,
            config.reason,
          )
        : null;
    const transitioned = await transitionLeaveDays(tx, {
      tenantId,
      employeeId: request.employee_id,
      requestId: request.request_id,
      leaveRequestDbId: request.id,
      dates: actionDates,
      fromStates: config.sourceStates,
      toState: config.toState,
      cause: config.cause,
      actorId,
      reason: config.reason,
      notification,
    });
    // Spec §4: the refreshed view carries the action's split array.
    const view = await this.buildView(tx, tenantId, request);
    return this.withActionDates(view, config.cause, transitioned);
  }

  /** revokedDates on a revoke, cancelledDates on a cancel (spec §4). */
  private withActionDates(
    view: LeaveRequestView,
    cause: LeaveCause,
    dates: string[],
  ): LeaveRequestView {
    if (cause === 'owner_revoke') {
      return { ...view, revokedDates: dates };
    }
    if (cause === 'employee_cancel') {
      return { ...view, cancelledDates: dates };
    }
    return view;
  }

  // ---------------------------------------------------------------- cancel

  private async cancelTransact(
    tx: PoolClient,
    tenantId: string,
    employeeId: string,
    leaveRequestId: string,
  ): Promise<LeaveRequestView> {
    const found = await findRequestWithDays(
      tx,
      tenantId,
      leaveRequestId,
      employeeId,
    );
    if (!found) throw leaveNotFound();
    const { request } = found;
    await lockTenantShared(tx, tenantId);
    await tx.query('select public.attendance_lock_employee($1)', [employeeId]);
    const today = await tenantToday(tx, tenantId);

    const sourceDays = await findDaysInStates(
      tx,
      request.id,
      CANCEL_SOURCE_STATES,
    );
    const split = await this.splitForRequest(
      tx,
      tenantId,
      employeeId,
      today,
      sourceDays,
      CANCEL_SOURCE_STATES,
    );
    if (split.actionDates.length === 0) {
      const last = await findLastEvent(tx, request.id);
      if (last?.cause === 'employee_cancel' && last.actorId === employeeId) {
        return this.buildView(tx, tenantId, request); // AD-6 own retry
      }
      throw leaveRejectionToException({
        errorCode: ErrorCode.LEAVE_NOT_CANCELLABLE,
        message: 'No future dates left to cancel',
      });
    }

    // 23-7 follow-up: the same freeze backstop as revoke — actionable dates
    // are today-or-future, so this only fires under a same-day run+lock,
    // but a frozen date must refuse the same way a frozen correction does.
    await assertPayrollDatesEditable(tx, tenantId, split.actionDates);

    await transitionLeaveDays(tx, {
      tenantId,
      employeeId,
      requestId: request.request_id,
      leaveRequestDbId: request.id,
      dates: split.actionDates,
      fromStates: CANCEL_SOURCE_STATES,
      toState: 'cancelled',
      cause: 'employee_cancel',
      actorId: employeeId,
      reason: null,
      notification: await this.ownerNotification(tx, tenantId, {
        payload: {
          employeeName: await readEmployeeName(tx, tenantId, employeeId),
          startDate: request.start_date,
          endDate: request.end_date,
          cancelledDates: split.actionDates,
        },
      }),
    });
    const view = await this.buildView(tx, tenantId, request);
    return { ...view, cancelledDates: split.actionDates };
  }

  // --------------------------------------------------------------- helpers

  /** The registry-mapped notification payload per cause (D14). */
  private async notificationFor(
    tx: PoolClient,
    tenantId: string,
    cause: 'approve' | 'reject' | 'owner_revoke',
    request: { employee_id: string; start_date: string; end_date: string },
    actionDates: string[],
    reason: string | null,
  ): Promise<{ recipientIds: string[]; payload: Record<string, unknown> }> {
    if (cause === 'owner_revoke') {
      return {
        recipientIds: [request.employee_id],
        payload: {
          startDate: request.start_date,
          endDate: request.end_date,
          revokedDates: actionDates,
          reason,
        },
      };
    }
    if (cause === 'reject') {
      return {
        recipientIds: [request.employee_id],
        payload: {
          startDate: request.start_date,
          endDate: request.end_date,
          reason,
        },
      };
    }
    const spanFacts = await this.spanFactsFor(
      tx,
      tenantId,
      request.employee_id,
      {
        start_date: request.start_date,
        end_date: request.end_date,
      },
    );
    return {
      recipientIds: [request.employee_id],
      payload: {
        startDate: request.start_date,
        endDate: request.end_date,
        workingDays: countWorkingDays(actionDates, spanFacts),
      },
    };
  }

  /**
   * The D8 split for revoke/cancel — startMinute comes from the day
   * context (the ONE source of the office-start cutoff); nowMinute from
   * the DB clock (the 16-1 skew lesson).
   */
  private async splitForRequest(
    tx: PoolClient,
    tenantId: string,
    employeeId: string,
    today: string,
    sourceDays: { leave_date: string; state: LeaveDayState }[],
    sourceStates: LeaveDayState[],
  ): Promise<{
    actionDates: string[];
    keepDates: {
      date: string;
      state: LeaveDayState;
      reason: 'past' | 'cutoff_passed';
    }[];
  }> {
    const ctx = await buildDayContext(tx, tenantId, employeeId, today, false);
    const now = await dbNow(tx);
    return splitActionableDates(sourceDays, {
      today,
      nowMinute: nowMinuteIn(ctx.timezone, now),
      startMinute: ctx.startMinute,
      sourceStates,
    });
  }

  private async spanFactsFor(
    tx: PoolClient,
    tenantId: string,
    employeeId: string,
    request: { start_date: string; end_date: string },
  ) {
    const dates = enumerateDates(request.start_date, request.end_date);
    return readSpanFacts(
      tx,
      tenantId,
      employeeId,
      dates,
      pickWeeklyOffDays,
      isoWeekdayOf,
    );
  }

  /** The refreshed wire view for a request (working days recomputed, D5). */
  private async buildView(
    tx: PoolClient,
    tenantId: string,
    request: { id: string },
  ): Promise<LeaveRequestView> {
    const found = await findRequestWithDays(tx, tenantId, request.id);
    if (!found) throw internalError('Leave request vanished mid-transaction');
    const spanFacts = await this.spanFactsFor(
      tx,
      tenantId,
      found.request.employee_id,
      {
        start_date: found.request.start_date,
        end_date: found.request.end_date,
      },
    );
    const dates = found.days.map((d) => d.leave_date);
    return toRequestView(
      found.request,
      found.days,
      countWorkingDays(dates, spanFacts),
    );
  }

  /** Admin-facing notification bundle (recipients = every active company admin). */
  private async ownerNotification(
    tx: PoolClient,
    tenantId: string,
    input: { payload: Record<string, unknown> },
  ): Promise<{ recipientIds: string[]; payload: Record<string, unknown> }> {
    const adminIds = await readCompanyAdminIds(tx, tenantId);
    if (adminIds.length === 0) {
      this.logger.error('Leave notification: company has no active admin', {
        tenantId,
      });
    }
    return { recipientIds: adminIds, payload: input.payload };
  }
}
