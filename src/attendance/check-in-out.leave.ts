import { Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { findActiveLeaveForDate } from './leave.repository';
import { transitionLeaveDays } from './leave-transition';
import { readEmployeeName } from './leave.repository';
import { readCompanyAdminIds } from './company-admins';
import { hasFrozenPayrollDate } from './payroll-date-gate';

/**
 * FR-9's accepted path (17-4, spec D11): a CONFIRMED check-in on a
 * full-day active leave day cancels ONLY that date — the rest of a
 * multi-day request is untouched — and notifies the owner once for the
 * date (dedupe key carries the date, so the same request can auto-cancel
 * several dates across several days without colliding). Runs inside the
 * check-in transaction, AFTER the location ladder has passed: a rejected
 * attempt (too_far etc.) must never touch leave.
 */

const logger = new Logger('CheckInOutLeave');

export async function autoCancelLeaveForCheckIn(
  tx: PoolClient,
  input: {
    tenantId: string;
    employeeId: string;
    workDate: string;
  },
): Promise<void> {
  const leave = await findActiveLeaveForDate(
    tx,
    input.employeeId,
    input.workDate,
  );
  if (!leave) {
    // The gate saw leave, the ladder passed, and now it is gone — a same-
    // transaction writer would have held this employee's lock; treat a
    // vanished row as a contract break and fail loud.
    logger.error('Leave vanished between the gate and the accepted path', {
      employeeId: input.employeeId,
      workDate: input.workDate,
    });
    return;
  }
  // 23-7 follow-up: a same-day run+lock (the run opens on the cut-off day,
  // the lock can follow immediately) can freeze TODAY. The auto-cancel
  // must not rewrite frozen input — but it runs inside the check-in
  // transaction, so it SKIPS the cancel (logged) instead of failing the
  // check-in: the employee standing at the gate is operational reality,
  // not a payslip edit.
  if (await hasFrozenPayrollDate(tx, input.tenantId, [input.workDate])) {
    logger.warn(
      'Check-in auto-cancel skipped — the date is locked for payroll',
      { employeeId: input.employeeId, workDate: input.workDate },
    );
    return;
  }
  const adminIds = await readCompanyAdminIds(tx, input.tenantId);
  const employeeName = await readEmployeeName(
    tx,
    input.tenantId,
    input.employeeId,
  );
  await transitionLeaveDays(tx, {
    tenantId: input.tenantId,
    employeeId: input.employeeId,
    requestId: leave.requestId,
    leaveRequestDbId: leave.leaveRequestDbId,
    dates: [input.workDate],
    fromStates: ['pending', 'approved'],
    toState: 'cancelled',
    cause: 'checkin_auto_cancel',
    actorId: input.employeeId,
    reason: null,
    notification:
      adminIds.length > 0
        ? {
            recipientIds: adminIds,
            payload: { employeeName, leaveDate: input.workDate },
            dedupeSuffix: input.workDate,
          }
        : null,
  });
}
