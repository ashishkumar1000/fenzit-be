import type { PoolClient } from 'pg';
import { HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ErrorCode } from '../common/enums/error-code.enum';
import { internalError } from './attendance-rpc.helpers';
import { buildDayContext } from './day-context.read';
import {
  computeEarlyCheckoutMinutes,
  computeLateMinutes,
  DayContext,
  expectedEndMinute,
  expectedStartMinute,
  minuteOfDayInTz,
} from '../common/day-status/day-context';
import {
  findAttemptByIdempotencyKey,
  readActiveBlockedUntil,
  AttemptKind,
  AttemptRow,
} from './check-in-out.repository';
import {
  findRecordByAttemptId,
  findRecordByEmployeeDate,
  RecordRow,
} from './check-in-out.records.repository';
import {
  CheckInResponse,
  CheckOutResponse,
  DayContextFlags,
  outcomeToException,
  recordToResponse,
  ResponseMetrics,
} from './check-in-out.model';
import { tenantToday } from './enrolments.repository';

/**
 * The AD-6 replay half of check-in/out (16-1/16-2), extracted from the
 * service at review for file size. A replayed key answers exactly what the
 * first call answered, with no second write; a burned key from the OTHER
 * button is a client bug answered from the current state, without writing.
 */

const logger = new Logger('CheckInOutReplay');

export async function replayResponse(
  tx: PoolClient,
  row: AttemptRow,
  employeeId: string,
  tenantId: string,
  kind: AttemptKind,
): Promise<{
  response?: CheckInResponse | CheckOutResponse;
  rejection?: HttpException;
}> {
  if (row.kind !== kind) {
    const record = await findRecordByEmployeeDate(
      tx,
      employeeId,
      await tenantToday(tx, tenantId),
    );
    if (kind === 'check_in' && record) {
      return {
        rejection: outcomeToException('already_checked_in', kind, {
          officeName: null,
        }),
      };
    }
    if (kind === 'check_out') {
      if (!record) {
        return {
          rejection: outcomeToException('not_checked_in', kind, {
            officeName: null,
          }),
        };
      }
      if (record.checkout_at) {
        return {
          rejection: outcomeToException('already_checked_out', kind, {
            officeName: null,
          }),
        };
      }
    }
    // check_in with no record yet: the burned key cannot take the new
    // attempt row, so the call cannot proceed — say so plainly.
    return {
      rejection: new HttpException(
        {
          error_code: ErrorCode.DUPLICATE_RESOURCE,
          message: 'This confirmation key was already used',
        },
        HttpStatus.CONFLICT,
      ),
    };
  }

  if (row.outcome === 'ok') {
    const record = await findRecordByAttemptId(tx, row.id);
    if (!record) {
      logger.error('Replay of an ok attempt without its record', {
        attemptId: row.id,
      });
      throw internalError('Failed to rebuild the attendance record');
    }
    const ctx = await buildDayContext(
      tx,
      tenantId,
      employeeId,
      record.work_date,
      true,
    );
    return {
      response: recordToResponse(
        record,
        kind,
        ctx.timezone,
        toFlags(ctx),
        metricsFor(ctx, kind, record),
      ),
    };
  }

  let retryAfterSeconds: number | undefined;
  if (row.outcome === 'rate_limited') {
    // The rate_limited row carries no blocked_until of its own; answer the
    // block that is still live for this employee, if any (review finding:
    // a stale 1-second figure invites an immediate re-429).
    const active = await readActiveBlockedUntil(tx, employeeId);
    retryAfterSeconds = active
      ? Math.max(1, Math.ceil((active.getTime() - Date.now()) / 1000))
      : undefined;
  }
  return {
    rejection: outcomeToException(row.outcome, kind, {
      officeName: null,
      distanceM: row.distance_m ?? 0,
      radiusM: row.radius_m ?? 0,
      retryAfterSeconds,
    }),
  };
}

/** D12 metrics — late for check-in, early-checkout for check-out. The
 * FR-7 half-day expectations (spec-17 D3) shift the reference: a
 * first-half leave day expects the employee from the Midpoint, a
 * second-half leave day until the Midpoint. */
export function metricsFor(
  ctx: DayContext,
  kind: AttemptKind,
  record: RecordRow,
): ResponseMetrics {
  if (kind === 'check_in') {
    const startMinute = expectedStartMinute(ctx);
    if (startMinute === null || ctx.lateCutoffMinutes === null) {
      return NO_METRICS;
    }
    const lateMinutes = computeLateMinutes(
      minuteOfDayInTz(new Date(record.checkin_at), ctx.timezone),
      startMinute,
      ctx.lateCutoffMinutes,
    );
    return {
      lateMinutes,
      isLate: lateMinutes > 0,
      earlyCheckout: false,
      earlyCheckoutMinutes: null,
    };
  }
  const endMinute = expectedEndMinute(ctx);
  if (endMinute === null || !record.checkout_at) {
    return NO_METRICS;
  }
  const earlyCheckoutMinutes = computeEarlyCheckoutMinutes(
    minuteOfDayInTz(new Date(record.checkout_at), ctx.timezone),
    endMinute,
  );
  return {
    lateMinutes: null,
    isLate: false,
    earlyCheckout: earlyCheckoutMinutes !== null,
    earlyCheckoutMinutes,
  };
}

const NO_METRICS: ResponseMetrics = {
  lateMinutes: null,
  isLate: false,
  earlyCheckout: false,
  earlyCheckoutMinutes: null,
};

export function toFlags(ctx: DayContext): DayContextFlags {
  return {
    isWeeklyOff: ctx.isWeeklyOff,
    isHoliday: ctx.holidayId !== null,
    holidayName: ctx.holidayName,
    isWorkingDay: ctx.isWorkingDay,
  };
}
