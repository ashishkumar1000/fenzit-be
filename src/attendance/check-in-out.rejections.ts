import type { PoolClient } from 'pg';
import { HttpException, HttpStatus, Logger } from '@nestjs/common';
import {
  COUNTED_OUTCOMES,
  FAKE_LOCATION_ALERT_THRESHOLD,
  RATE_BLOCK_MINUTES,
  RATE_MAX_COUNTED,
} from './constants';
import { dbNow, countCountedInWindow, countMonthlyMocked, insertAttempt, insertFakeLocationAlert, readOwnerId, AttemptKind, AttemptLocation } from './check-in-out.repository';
import { DayContext } from './day-context';
import { ErrorCode } from '../common/enums/error-code.enum';
import { ATTENDANCE_NOTIFICATION_EVENT } from './notification-events';
import { readEmployee } from './enrolments.repository';
import { outcomeToException } from './check-in-out.model';

/**
 * The committed-rejection paths of check-in/out (16-1/16-2), extracted from
 * the service at review for file size. Every function here WRITES the
 * attempt row and RETURNS the mapped exception — the caller throws it only
 * after COMMIT (AD-4: the attempt row must survive the rejection).
 */

/** AD-15 budget: the Nth counted rejection arms the block on its row. */
export async function rejectWithLadder(
  tx: PoolClient,
  input: {
    tenantId: string;
    employeeId: string;
    requestId: string;
    kind: AttemptKind;
    rejection: string;
    ctx: DayContext;
    location: AttemptLocation;
  },
): Promise<HttpException> {
  let blockedUntil: Date | null = null;
  if ((COUNTED_OUTCOMES as readonly string[]).includes(input.rejection)) {
    const counted = await countCountedInWindow(tx, input.employeeId);
    if (counted + 1 >= RATE_MAX_COUNTED) {
      // The DB clock, not the app clock — the window comparisons run on
      // now() (review finding: skew would stretch/shorten the block).
      blockedUntil = new Date(
        (await dbNow(tx)).getTime() + RATE_BLOCK_MINUTES * 60_000,
      );
    }
  }
  const attemptId = await insertAttempt(tx, {
    tenantId: input.tenantId,
    employeeId: input.employeeId,
    requestId: input.requestId,
    kind: input.kind,
    outcome: input.rejection,
    location: input.location,
    blockedUntil,
  });
  if (attemptId === null) {
    // The key was burned concurrently by another employee — no second row.
    return duplicateKeyRejection(input.kind);
  }
  if (input.rejection === 'mocked') {
    await maybeAlertFakeLocation(tx, input.ctx);
  }
  return outcomeToException(input.rejection, input.kind, {
    officeName: input.ctx.officeName,
    distanceM: input.location.distanceM ?? 0,
    radiusM: input.ctx.radiusM ?? 0,
  });
}

/** Committed state-conflict outcomes (recorded, not counted). */
export async function rejectCommitted(
  tx: PoolClient,
  employeeId: string,
  tenantId: string,
  requestId: string,
  kind: AttemptKind,
  input: {
    outcome: string;
    location: AttemptLocation;
    officeName: string | null;
  },
): Promise<HttpException> {
  const attemptId = await insertAttempt(tx, {
    tenantId,
    employeeId,
    requestId,
    kind,
    outcome: input.outcome,
    location: input.location,
    blockedUntil: null,
  });
  if (attemptId === null) {
    return duplicateKeyRejection(kind);
  }
  return outcomeToException(input.outcome, kind, {
    officeName: input.officeName,
  });
}

/** A raced idempotency key answers 409 with no second row (spec D15). */
export function duplicateKeyRejection(_kind: AttemptKind): HttpException {
  return new HttpException(
    {
      error_code: ErrorCode.DUPLICATE_RESOURCE,
      message: 'This confirmation key was already used',
    },
    HttpStatus.CONFLICT,
  );
}

const logger = new Logger('CheckInOutRejections');

/**
 * AD-13/D5: on the 3rd `mocked` attempt of the tenant-local calendar
 * month, notify the owner once. The dedupe key makes a same-month
 * re-entry a no-op at the index, so the count can safely include the row
 * this transaction just wrote.
 */
async function maybeAlertFakeLocation(
  tx: PoolClient,
  ctx: DayContext,
): Promise<void> {
  const { count, month } = await countMonthlyMocked(tx, ctx.employeeId, ctx.timezone);
  if (count < FAKE_LOCATION_ALERT_THRESHOLD) return;
  const ownerId = await readOwnerId(tx, ctx.tenantId);
  if (!ownerId) {
    logger.error('Fake-location alert: tenant has no owner', {
      tenantId: ctx.tenantId,
    });
    return;
  }
  const employee = await readEmployee(tx, ctx.tenantId, ctx.employeeId);
  await insertFakeLocationAlert(tx, {
    tenantId: ctx.tenantId,
    ownerId,
    employeeId: ctx.employeeId,
    employeeName: employee?.name ?? null,
    month,
    attemptCount: count,
    dedupeKey: [
      ctx.tenantId,
      ATTENDANCE_NOTIFICATION_EVENT.FAKE_LOCATION,
      ownerId,
      ctx.employeeId,
      month,
    ].join(':'),
  });
}
