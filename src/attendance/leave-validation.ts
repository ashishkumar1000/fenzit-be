import { ErrorCode } from '../common/enums/error-code.enum';
import {
  ACTIVE_LEAVE_STATES,
  LEAVE_MAX_PAST_DAYS,
  LEAVE_MAX_SPAN_DAYS,
  type LeaveDayState,
} from './leave.constants';
import type { LeaveRejection } from './leave.model';
import { isPastOfficeStart, minuteOfDayInTz } from './day-context';
import { addDays } from './enrolments-response.model';
import type { SpanDayFacts } from './leave.repository';

/**
 * D4 — the ONE validation path apply and preview share, and the ONE split
 * computation revoke/cancel and their previews share (AD-24). Pure over
 * already-read facts; the service reads, this decides.
 */

export interface ApplyShapeInput {
  startDate: string;
  endDate: string;
  part: 'full_day' | 'first_half' | 'second_half';
}

/** Format/pairing rules: valid ISO dates, half-day on a single date only.
 * The span cap lives HERE — arithmetically, BEFORE any enumeration — so a
 * crafted multi-year range can never allocate millions of date strings
 * (review finding: a cap after the loop is a DoS). */
export function validateApplyShape(
  input: ApplyShapeInput,
): LeaveRejection | null {
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRe.test(input.startDate) || !dateRe.test(input.endDate)) {
    return {
      errorCode: ErrorCode.LEAVE_INVALID_RANGE,
      message: 'Dates must be in YYYY-MM-DD format',
    };
  }
  if (input.endDate < input.startDate) {
    return {
      errorCode: ErrorCode.LEAVE_INVALID_RANGE,
      message: 'The end date cannot be before the start date',
    };
  }
  const spanDays =
    (Date.parse(input.endDate) - Date.parse(input.startDate)) / 86_400_000 + 1;
  if (spanDays > LEAVE_MAX_SPAN_DAYS) {
    return {
      errorCode: ErrorCode.LEAVE_INVALID_RANGE,
      message: `Leave can cover at most ${LEAVE_MAX_SPAN_DAYS} days at a time`,
    };
  }
  if (input.part !== 'full_day' && input.startDate !== input.endDate) {
    return {
      errorCode: ErrorCode.LEAVE_INVALID_RANGE,
      message: 'Half-day leave applies to a single date only',
    };
  }
  return null;
}

export function enumerateDates(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  let cursor = startDate;
  while (cursor <= endDate) {
    dates.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return dates;
}

export interface ApplyFactInput {
  today: string;
  /** D9 gate: enrolment exists; covering today OR floor in the future. */
  enrolment: { exists: boolean; floor: string | null; coversToday: boolean };
  settings: { setupCompleted: boolean; enabled: boolean };
  spanFacts: Map<string, SpanDayFacts>;
  overlappingDates: string[];
  checkedInDates: string[];
  /** D2 mirror gate: dates carrying a non-absent day override
   *  (status present | half_day, or a times-only correction) — the
   *  `findActiveOverrideDates` read's non-empty output. REQUIRED: a future
   *  consumer omitting the list would silently re-open the double-credit
   *  hole (review G2-P5). */
  overrideDates: string[];
}

/**
 * The D9 gate + the five rejection rules, in the D6 reporting order.
 * Returns the first rejection, or null when the range is applicable.
 */
export function validateApplyFacts(
  dates: string[],
  facts: ApplyFactInput,
): LeaveRejection | null {
  if (!facts.settings.setupCompleted || !facts.settings.enabled) {
    return {
      errorCode: ErrorCode.ATTENDANCE_NOT_TRACKED,
      message: 'Attendance is not active for you yet',
    };
  }
  const hasFutureStart =
    facts.enrolment.floor !== null && facts.enrolment.floor > facts.today;
  if (
    !facts.enrolment.exists ||
    (!facts.enrolment.coversToday && !hasFutureStart)
  ) {
    return {
      errorCode: ErrorCode.ATTENDANCE_NOT_TRACKED,
      message: 'Attendance is not active for you yet',
    };
  }
  const floor = facts.enrolment.floor;
  if (floor !== null && dates[0] < floor) {
    return {
      errorCode: ErrorCode.LEAVE_BEFORE_START_DATE,
      message: `You can apply for leave only on or after your start date (${floor})`,
    };
  }
  const oldestAllowed = addDays(facts.today, -LEAVE_MAX_PAST_DAYS);
  if (dates[0] < oldestAllowed) {
    return {
      errorCode: ErrorCode.LEAVE_TOO_OLD,
      message: `Leave can be applied at most ${LEAVE_MAX_PAST_DAYS} days in the past`,
    };
  }
  const checkedIn = facts.checkedInDates[0];
  if (checkedIn !== undefined) {
    return {
      errorCode: ErrorCode.LEAVE_CHECKED_IN_CONFLICT,
      message: `You have already checked in on ${checkedIn}. It cannot be requested as leave`,
    };
  }
  const workingDays = dates.filter((d) => facts.spanFacts.get(d)?.isWorkingDay);
  if (workingDays.length === 0) {
    // Before the mirror gate: an all-off span whose dates carry a
    // corrected OFF-day reads LEAVE_ALREADY_OFF, not a correction conflict
    // (the more specific rejection wins the report, G2-P6).
    return {
      errorCode: ErrorCode.LEAVE_ALREADY_OFF,
      message: 'These days are already off',
    };
  }
  // The D2 mirror gate: a corrected day is owner-resolved — approved leave
  // may sit only under a plain `absent` correction.
  const corrected = facts.overrideDates[0];
  if (corrected !== undefined) {
    return {
      errorCode: ErrorCode.LEAVE_CHECKED_IN_CONFLICT,
      message: `You have a correction on ${corrected}. It cannot be requested as leave`,
    };
  }
  const overlap = facts.overlappingDates[0];
  if (overlap !== undefined) {
    return {
      errorCode: ErrorCode.LEAVE_OVERLAP,
      message: `Your request overlaps existing leave on ${overlap}`,
    };
  }
  return null;
}

export interface SplitInput {
  today: string;
  nowMinute: number;
  /** D8: when no rule covers today there is no office start to miss — the
   * cutoff counts as NOT passed (null startMinute → actionable). */
  startMinute: number | null;
  sourceStates: LeaveDayState[];
}

export interface SplitOutcome {
  actionDates: string[];
  keepDates: {
    date: string;
    state: LeaveDayState;
    reason: 'past' | 'cutoff_passed';
  }[];
}

/**
 * D8 — the split rule: actionable = future dates, or today while the
 * Office-Start cutoff has not passed; restricted to the source states.
 * Off days in the span act like any other day (AD-23 "including off days").
 */
export function splitActionableDates(
  days: { leave_date: string; state: LeaveDayState }[],
  input: SplitInput,
): SplitOutcome {
  const cutoffPassed =
    input.startMinute !== null && input.nowMinute >= input.startMinute;
  const actionDates: string[] = [];
  const keepDates: SplitOutcome['keepDates'] = [];
  for (const day of days) {
    if (!input.sourceStates.includes(day.state)) continue;
    if (day.leave_date > input.today) {
      actionDates.push(day.leave_date);
    } else if (day.leave_date === input.today && !cutoffPassed) {
      actionDates.push(day.leave_date);
    } else {
      keepDates.push({
        date: day.leave_date,
        state: day.state,
        reason: day.leave_date < input.today ? 'past' : 'cutoff_passed',
      });
    }
  }
  return { actionDates, keepDates };
}

/** Working-day count for a request view (D5 — off days excluded). */
export function countWorkingDays(
  dates: string[],
  spanFacts: Map<string, SpanDayFacts>,
): number {
  return dates.filter((d) => spanFacts.get(d)?.isWorkingDay).length;
}

/** Convenience: the "now" minute in the tenant timezone (DB-clock callers). */
export function nowMinuteIn(timezone: string, now: Date): number {
  return minuteOfDayInTz(now, timezone);
}

export { ACTIVE_LEAVE_STATES };
