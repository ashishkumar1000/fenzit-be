import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCode } from '../common/enums/error-code.enum';
import { workedMinutesBetween } from '../common/day-status/day-context';
import type { AttemptKind, AttemptLocation, AttemptRow } from './check-in-out.repository';
import type { RecordRow } from './check-in-out.records.repository';
import type { CheckInOutDto } from './dto/check-in-out.dto';

/**
 * Response shapes and the outcome → HTTP mapping for check-in/out
 * (16-1/16-2). The mapping IS the AD-4 route contract: rejections are
 * committed outcomes (an attempt row is already durable when these fire)
 * expressed as ordinary error responses carrying the AD-4 catalogue codes.
 */

export interface DayContextFlags {
  isWeeklyOff: boolean;
  isHoliday: boolean;
  holidayName: string | null;
  isWorkingDay: boolean;
}

export interface CheckInResponse {
  workDate: string;
  /** ISO-8601 with the tenant offset (AD-7, spec D11). */
  checkinAt: string;
  /** Null when no rule covers today (D7). */
  lateMinutes: number | null;
  isLate: boolean;
  dayContext: DayContextFlags;
}

export interface CheckOutResponse {
  workDate: string;
  checkinAt: string;
  checkoutAt: string;
  /** Whole minutes from the stored instants (D12). */
  workedMinutes: number;
  earlyCheckout: boolean;
  earlyCheckoutMinutes: number | null;
  dayContext: DayContextFlags;
}

/**
 * ISO-8601 with the tenant offset ("2026-09-28T10:22:00+05:30") so the app
 * can render the wall-clock parts without knowing the timezone (AD-7, D11).
 * Deliberately NOT toISOString(): the 15-x UTC-Z metadata instants are
 * display-relative metadata; these times are wall-clock-meaningful.
 */
export function toTenantOffsetIso(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  const offset = timezoneOffset(instant, timezone);
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}${offset}`;
}

function timezoneOffset(instant: Date, timezone: string): string {
  const label = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    timeZoneName: 'longOffset',
  })
    .formatToParts(instant)
    .find((p) => p.type === 'timeZoneName')?.value;
  // "GMT+05:30" → "+05:30"; zero offsets surface as "GMT" or "GMT+00:00" —
  // both normalise to "Z" (valid ISO, and what the FE test-pin expects).
  const offset = label ? label.slice(3) : '';
  if (!offset || offset === '+00:00' || label === 'GMT') return 'Z';
  return offset;
}

export interface OutcomeExtras {
  officeName: string | null;
  distanceM?: number;
  radiusM?: number;
  retryAfterSeconds?: number;
}

/** The user-facing copy per outcome (PRD wording where it specifies one). */
export function outcomeMessage(
  outcome: string,
  kind: AttemptKind,
  extras: OutcomeExtras,
): string {
  switch (outcome) {
    case 'too_far':
      return `You are ${Math.round(extras.distanceM ?? 0)} m from ${extras.officeName ?? 'your office'}. Move within ${extras.radiusM ?? 0} m.`;
    case 'low_accuracy':
      return 'Location not accurate enough, try again in the open';
    case 'mocked':
      return `Turn off fake location apps to ${kind === 'check_in' ? 'check in' : 'check out'}`;
    case 'stale_fix':
      return 'Your location seems outdated. Refresh GPS and try again';
    case 'rate_limited':
      return `Too many attempts. Try again in ${Math.ceil((extras.retryAfterSeconds ?? 0) / 60)} min`;
    case 'not_tracked':
      return 'Attendance is not active for you yet';
    case 'already_checked_in':
      return 'You have already checked in today';
    case 'already_checked_out':
      return 'You have already checked out today';
    case 'not_checked_in':
      return 'Check in before checking out';
    case 'leave_confirmation_required':
      return 'You have leave today. Confirm to cancel it and check in';
    default:
      return 'Check-in could not be recorded';
  }
}

/** Outcome → HTTP status (AD-4 catalogue + D4's `already_checked_out`). */
export function outcomeStatus(outcome: string): number {
  switch (outcome) {
    case 'too_far':
    case 'low_accuracy':
    case 'mocked':
    case 'stale_fix':
      return HttpStatus.UNPROCESSABLE_ENTITY;
    case 'rate_limited':
      return HttpStatus.TOO_MANY_REQUESTS;
    case 'not_tracked':
      return HttpStatus.FORBIDDEN;
    case 'already_checked_in':
    case 'already_checked_out':
    case 'not_checked_in':
    case 'leave_confirmation_required':
      return HttpStatus.CONFLICT;
    case 'ok':
    default:
      return HttpStatus.CREATED;
  }
}

export function outcomeErrorCode(outcome: string): ErrorCode {
  const map: Record<string, ErrorCode> = {
    too_far: ErrorCode.ATTENDANCE_TOO_FAR,
    low_accuracy: ErrorCode.ATTENDANCE_LOW_ACCURACY,
    mocked: ErrorCode.ATTENDANCE_MOCK_LOCATION,
    stale_fix: ErrorCode.ATTENDANCE_STALE_FIX,
    rate_limited: ErrorCode.ATTENDANCE_RATE_LIMITED,
    not_tracked: ErrorCode.ATTENDANCE_NOT_TRACKED,
    already_checked_in: ErrorCode.ATTENDANCE_ALREADY_CHECKED_IN,
    already_checked_out: ErrorCode.ATTENDANCE_ALREADY_CHECKED_OUT,
    not_checked_in: ErrorCode.ATTENDANCE_NOT_CHECKED_IN,
    leave_confirmation_required: ErrorCode.ATTENDANCE_LEAVE_CONFIRMATION_REQUIRED,
  };
  return map[outcome] ?? ErrorCode.INTERNAL_SERVER_ERROR;
}

/** The committed outcome expressed as the HTTP response (rejections only). */
export function outcomeToException(
  outcome: string,
  kind: AttemptKind,
  extras: OutcomeExtras,
): HttpException {
  const status = outcomeStatus(outcome);
  const body: Record<string, unknown> = {
    error_code: outcomeErrorCode(outcome),
    message: outcomeMessage(outcome, kind, extras),
  };
  if (outcome === 'too_far') {
    body['distanceM'] = Math.round(extras.distanceM ?? 0);
    body['radiusM'] = extras.radiusM ?? 0;
  }
  if (outcome === 'rate_limited') {
    body['retryAfterSeconds'] = Math.max(1, Math.ceil(extras.retryAfterSeconds ?? 1));
  }
  return new HttpException(body, status);
}

/** Response metrics recomputed from the day context (fresh call or replay). */
export interface ResponseMetrics {
  lateMinutes: number | null;
  isLate: boolean;
  earlyCheckout: boolean;
  earlyCheckoutMinutes: number | null;
}

/** Rebuilds the success response from the stored record (AD-6 replay). */
export function recordToResponse(
  record: RecordRow,
  kind: AttemptKind,
  timezone: string,
  flags: DayContextFlags,
  metrics: ResponseMetrics,
): CheckInResponse | CheckOutResponse {
  const checkinAt = toTenantOffsetIso(new Date(record.checkin_at), timezone);
  if (kind === 'check_in') {
    return {
      workDate: record.work_date,
      checkinAt,
      lateMinutes: metrics.lateMinutes,
      isLate: metrics.isLate,
      dayContext: flags,
    };
  }
  const checkoutAt = new Date(record.checkout_at as Date | string);
  const workedMinutes = workedMinutesBetween(
    record.checkin_at,
    record.checkout_at as Date | string,
  );
  return {
    workDate: record.work_date,
    checkinAt,
    checkoutAt: toTenantOffsetIso(checkoutAt, timezone),
    workedMinutes,
    earlyCheckout: metrics.earlyCheckout,
    earlyCheckoutMinutes: metrics.earlyCheckoutMinutes,
    dayContext: flags,
  };
}

/** The submitted fix as the attempt row stores it (shared by service and
 * the rejection paths). An empty/whitespace provider normalises to null. */
export function toAttemptLocation(
  dto: CheckInOutDto,
  radiusM: number | null,
  distanceM?: number,
): AttemptLocation {
  const provider = dto.provider?.trim();
  return {
    latitude: dto.latitude,
    longitude: dto.longitude,
    accuracyM: dto.accuracyM,
    distanceM: distanceM ?? null,
    radiusM,
    mocked: dto.mocked ?? null,
    provider: provider ? provider : null,
    fixAgeMs: dto.fixAgeMs,
  };
}
