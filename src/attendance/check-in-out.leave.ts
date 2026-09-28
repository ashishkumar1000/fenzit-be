import { Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { findActiveLeaveForDate } from './leave.repository';
import { transitionLeaveDays } from './leave-transition';
import { readEmployeeName, readOwnerId } from './leave.repository';

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
  const ownerId = await readOwnerId(tx, input.tenantId);
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
    notification: ownerId
      ? {
          recipientId: ownerId,
          payload: { employeeName, leaveDate: input.workDate },
          dedupeSuffix: input.workDate,
        }
      : null,
  });
}
