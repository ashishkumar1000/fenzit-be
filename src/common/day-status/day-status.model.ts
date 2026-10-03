/**
 * THE FR-10 day-status engine (18-1) — first-match-wins through the ten
 * rules and the FR-11 credit graders, in exactly ONE place. Every Epic 18
 * route, and every Epic 19 aggregate, reads rows only from here — a
 * calendar cell, a day-detail sheet and an owner dashboard can never
 * disagree about a day's status (the 15-9 drift class, closed).
 *
 * Pure over already-read facts (AD-22 shape): a `DayContext` per row (the
 * assembled facts, including the leave seam), the day's record row, the
 * day's ACTIVE override row and the unacknowledged-mocked-attempt flag.
 * Interplay rules the ladder carries:
 *  - A status-only correction short-circuits; a times-only correction
 *    replaces the instants and evaluation CONTINUES through rules 2-10
 *    (a corrected check-in on a Weekly off/Holiday reads worked_on_holiday,
 *    never 'present' on an off-day).
 *  - Leave outranked by rules 1/3/4/7 keeps its day rows as data but earns
 *    NO credits (the row shows the winning status).
 *  - No Late/Early flag on any off-day-derived status (PRD decided v1).
 *  - `not_tracked` loses only to rule 1 — a history-preservation arm for
 *    dates whose enrolment ended later (the write gate blocks NEW
 *    corrections on untracked dates).
 */
import type { DayContext } from './day-context';
import {
  computeEarlyCheckoutMinutes,
  computeLateMinutes,
  minuteOfDayInTz,
  workedMinutesBetween,
} from './day-context';
import type {
  AttendanceSource,
  DayMarkerKey,
  DayStatusKey,
} from './keys';

export { STATUS_KEYS_READONLY as STATUS_KEYS } from './keys';
export { MARKER_KEYS_READONLY as MARKER_KEYS } from './keys';
export type {
  AttendanceSource,
  DayMarkerKey,
  DayStatusKey,
} from './keys';

/** The day's `attendance_records` row (the subset the engine reads). */
export interface EngineRecordRow {
  checkin_at: Date | string;
  checkout_at: Date | string | null;
}

/** The day's ACTIVE override row (deleted_at IS NULL — pre-filtered). */
export interface EngineOverrideRow {
  status: string | null;
  manual_checkin_at: Date | string | null;
  manual_checkout_at: Date | string | null;
}

/** Per-date engine input. `today` is the DB-clock tenant-local date. */
export interface DayStatusInput {
  ctx: DayContext;
  record: EngineRecordRow | null;
  override: EngineOverrideRow | null;
  /** AD-10: any unacknowledged mocked attempt on this employee-date. */
  hasUnackMockedAttempt: boolean;
  today: string;
}

/** The engine outcome — the numbers one row shows (the wire mapping adds
 *  ISO instants and the ctx labels). */
export interface DayStatusOutcome {
  status: DayStatusKey;
  lateMinutes: number | null;
  isLate: boolean;
  earlyCheckoutMinutes: number | null;
  earlyCheckout: boolean;
  workedMinutes: number | null;
  daysWorked: number;
  leaveCredit: number;
  workedOnHolidayCredit: number;
  /** Effective instants' sources — a times-only override marks its fields. */
  checkinSource: AttendanceSource;
  checkoutSource: AttendanceSource;
  markers: DayMarkerKey[];
}

/** The zero metrics a rule without any instants returns. */
function nullMetrics(): Pick<
  DayStatusOutcome,
  'lateMinutes' | 'isLate' | 'earlyCheckoutMinutes' | 'earlyCheckout'
> {
  return {
    lateMinutes: null,
    isLate: false,
    earlyCheckoutMinutes: null,
    earlyCheckout: false,
  };
}

/**
 * The instants rule 1's times-only arm substitutes — PER FIELD: a
 * checkout-only row corrects only the checkout and keeps the record's
 * check-in (each corrected field carries its 'manual' source, each
 * record-served field stays 'gps').
 */
export function effectiveInstants(
  record: EngineRecordRow | null,
  override: EngineOverrideRow | null,
): {
  checkin: Date | null;
  checkout: Date | null;
  checkinSource: AttendanceSource;
  checkoutSource: AttendanceSource;
} {
  const overrideCheckin = override?.manual_checkin_at != null;
  const overrideCheckout = override?.manual_checkout_at != null;
  const checkin = overrideCheckin
    ? new Date(override!.manual_checkin_at as Date | string)
    : record
      ? new Date(record.checkin_at)
      : null;
  const checkout = overrideCheckout
    ? new Date(override!.manual_checkout_at as Date | string)
    : record?.checkout_at
      ? new Date(record.checkout_at as Date | string)
      : null;
  return {
    checkin,
    checkout,
    checkinSource: overrideCheckin ? 'manual' : record ? 'gps' : null,
    checkoutSource: overrideCheckout
      ? 'manual'
      : record?.checkout_at
        ? 'gps'
        : null,
  };
}

/** GR-1: a status-only correction fixes the grade directly (FR-11). */
function daysWorkedForFixed(
  status: 'present' | 'half_day' | 'absent',
): number {
  return status === 'present' ? 1 : status === 'half_day' ? 0.5 : 0;
}

/** GR-2: rule 3's grade — credit by the owner-configured thresholds
 * (G2-D1 ruling: `full_day_hours`/`half_day_hours` ARE the grading
 * thresholds); open → 0. No rule (null thresholds) → the permissive arm. */
function workedOnHolidayGrade(
  workedMinutes: number | null,
  fullDayMinutes: number | null,
  halfDayMinutes: number | null,
): number {
  if (workedMinutes === null) return 0;
  if (fullDayMinutes === null) {
    // No rule covers the date — no thresholds exist; the permissive
    // reading credits any positive shift as full (GR-3's no-rule arm).
    return workedMinutes > 0 ? 1 : 0;
  }
  if (workedMinutes >= fullDayMinutes) return 1;
  if (halfDayMinutes === null || workedMinutes >= halfDayMinutes) return 0.5;
  return 0;
}

/**
 * GR-3: rule 7's grade. No rule → the permissive reading (worked minutes
 * present reads present — a record without a covering rule has no
 * thresholds to compare against).
 */
function gradeWorked(
  workedMinutes: number,
  fullDayMinutes: number | null,
  halfDayMinutes: number | null,
): 'present' | 'half_day' | 'absent' {
  if (fullDayMinutes === null) {
    return workedMinutes > 0 ? 'present' : 'absent';
  }
  if (workedMinutes >= fullDayMinutes) return 'present';
  if (halfDayMinutes === null || workedMinutes >= halfDayMinutes) {
    return 'half_day';
  }
  return 'absent';
}

/**
 * computeDayStatus — the ten FR-10 rules, first-match-wins. The
 * `leave_pending` marker (any pending-leave part covering the date) rides
 * every status, per rule 10's letter — the calendar keeps the indication
 * on the one day it is most actionable.
 */
export function computeDayStatus(input: DayStatusInput): DayStatusOutcome {
  const { ctx, record, override, today } = input;
  const isPast = ctx.workDate < today;
  const markers: DayMarkerKey[] = [];
  if (input.hasUnackMockedAttempt) markers.push('fake_location_attempt');
  if (override) markers.push('corrected');
  if (ctx.leaveState === 'pending') markers.push('leave_pending');

  const { checkin, checkout, checkinSource, checkoutSource } =
    effectiveInstants(record, override);
  // G2-D1 ruling (2026-09-29): the full/half-day thresholds are the
  // owner-configured `full_day_hours`/`half_day_hours` columns — the window
  // span drives only the late/early metrics.
  const fullDayMinutes = ctx.fullDayMinutes;
  const halfDayMinutes = ctx.halfDayMinutes;
  const workingMinutes =
    checkin && checkout ? workedMinutesBetween(checkin, checkout) : null;

  // Late / early ride every rule with a covering rule + instants — except
  // the off-day statuses (rule 3's decided suppression carries to rule 4).
  const metrics = (): Pick<
    DayStatusOutcome,
    'lateMinutes' | 'isLate' | 'earlyCheckoutMinutes' | 'earlyCheckout'
  > => {
    if (!checkin || ctx.startMinute === null) return nullMetrics();
    const lateMinutes = computeLateMinutes(
      minuteOfDayInTz(checkin, ctx.timezone),
      ctx.startMinute,
      ctx.lateCutoffMinutes ?? 0,
    );
    const earlyCheckoutMinutes =
      checkout && ctx.endMinute !== null
        ? computeEarlyCheckoutMinutes(
            minuteOfDayInTz(checkout, ctx.timezone),
            ctx.endMinute,
          )
        : null;
    return {
      lateMinutes,
      isLate: lateMinutes > 0,
      earlyCheckoutMinutes,
      earlyCheckout: earlyCheckoutMinutes !== null,
    };
  };

  // ---- Rule 1: an active correction wins ----------------------------------
  if (override?.status != null) {
    const status = override.status as 'present' | 'half_day' | 'absent';
    // A status-only arm never yields an off-day status (worked_on_holiday
    // comes only from rule 3), so Late/Early read the effective instants
    // like any stored record.
    return {
      status,
      ...metrics(),
      workedMinutes: workingMinutes,
      daysWorked: daysWorkedForFixed(status),
      leaveCredit: 0, // outranked leave keeps its rows as data, earns none
      workedOnHolidayCredit: 0,
      checkinSource,
      checkoutSource,
      markers,
    };
  }

  // ---- Rule 2: not tracked ------------------------------------------------
  if (!ctx.tracked) {
    return {
      status: 'not_tracked',
      ...nullMetrics(),
      workedMinutes: workingMinutes, // history the owner may still review
      daysWorked: 0,
      leaveCredit: 0,
      workedOnHolidayCredit: 0,
      checkinSource,
      checkoutSource,
      markers,
    };
  }

  // ---- Rule 3: worked on a weekly off / holiday (credit separate) ---------
  if ((ctx.isWeeklyOff || ctx.holidayId !== null) && checkin) {
    return {
      status: 'worked_on_holiday',
      ...nullMetrics(), // no Late/Early flag on Weekly off / Holiday check-ins
      workedMinutes: workingMinutes,
      daysWorked: 0, // never mixed in (FR-11)
      leaveCredit: 0, // leave behind rule 3 stays data-only
      workedOnHolidayCredit: workedOnHolidayGrade(
        workingMinutes,
        fullDayMinutes,
        halfDayMinutes,
      ),
      checkinSource,
      checkoutSource,
      markers:
        isPast && !checkout ? [...markers, 'checkout_missing'] : markers,
    };
  }

  // ---- Rule 4: weekly off, else holiday (no check-in) -----------------------
  if (ctx.isWeeklyOff) {
    return {
      status: 'weekly_off',
      ...nullMetrics(),
      workedMinutes: null,
      daysWorked: 0,
      leaveCredit: 0,
      workedOnHolidayCredit: 0,
      checkinSource,
      checkoutSource,
      markers,
    };
  }
  if (ctx.holidayId !== null) {
    return {
      status: 'holiday',
      ...nullMetrics(),
      workedMinutes: null,
      daysWorked: 0,
      leaveCredit: 0,
      workedOnHolidayCredit: 0,
      checkinSource,
      checkoutSource,
      markers,
    };
  }

  // ---- Rule 5: approved full-day leave, no check-in --------------------------
  if (
    ctx.leaveState === 'approved' &&
    ctx.leavePart === 'full_day' &&
    !checkin
  ) {
    return {
      status: 'leave',
      ...nullMetrics(),
      workedMinutes: null,
      daysWorked: 0,
      leaveCredit: 1,
      workedOnHolidayCredit: 0,
      checkinSource,
      checkoutSource,
      markers,
    };
  }

  // ---- Rule 6: approved half-day leave ---------------------------------------
  // An OPEN record on TODAY defers to rule 10 ("open by midnight" cannot
  // be known yet) — the open-record arm (working half 0 + checkout_missing)
  // is PAST-only.
  if (ctx.leaveState === 'approved' && ctx.leavePart !== 'full_day') {
    const openToday = checkin !== null && checkout === null && !isPast;
    if (!openToday) {
      const pastOpen = checkin !== null && checkout === null && isPast;
      const earnedHalf =
        workingMinutes !== null &&
        halfDayMinutes !== null &&
        workingMinutes >= halfDayMinutes;
      return {
        status: 'half_day_leave',
        ...metrics(),
        workedMinutes: workingMinutes,
        daysWorked: earnedHalf && checkout !== null ? 0.5 : 0,
        leaveCredit: 0.5,
        workedOnHolidayCredit: 0,
        checkinSource,
        checkoutSource,
        markers: pastOpen ? [...markers, 'checkout_missing'] : markers,
      };
    }
  }

  // ---- Rule 7: check-in with check-out, graded by the worked minutes --------
  if (checkin && checkout) {
    const status = gradeWorked(workingMinutes as number, fullDayMinutes, halfDayMinutes);
    return {
      status,
      ...metrics(),
      workedMinutes: workingMinutes,
      // The credit rides the grade — GR-1's same mapping, one place.
      daysWorked: daysWorkedForFixed(status),
      leaveCredit: 0, // leave outranked by a worked day stays data-only
      workedOnHolidayCredit: 0,
      checkinSource,
      checkoutSource,
      markers, // a pending leave riding a worked day keeps the marker
    };
  }

  // ---- Rule 8: past date, check-in with no check-out --------------------------
  if (isPast && checkin) {
    return {
      status: 'checkout_missing',
      ...metrics(), // late still shows; early is null without a checkout
      workedMinutes: null,
      daysWorked: 0, // zero "until corrected" — a later correction flips it live
      leaveCredit: 0,
      workedOnHolidayCredit: 0,
      checkinSource,
      checkoutSource,
      markers: [...markers, 'checkout_missing'],
    };
  }

  // ---- Rule 9: past date, no check-in, no approved leave ----------------------
  if (isPast) {
    return {
      status: 'absent',
      ...nullMetrics(),
      workedMinutes: null,
      daysWorked: 0,
      leaveCredit: 0,
      workedOnHolidayCredit: 0,
      checkinSource,
      checkoutSource,
      markers, // pending leave shows the marker, never a status change
    };
  }

  // ---- Rule 10: today / future -------------------------------------------------
  if (!checkin) {
    return {
      status: 'not_checked_in_yet',
      ...nullMetrics(),
      workedMinutes: null,
      daysWorked: 0,
      leaveCredit: 0,
      workedOnHolidayCredit: 0,
      checkinSource,
      checkoutSource,
      markers,
    };
  }
  return {
    status: 'in_progress',
    ...metrics(),
    workedMinutes: null,
    daysWorked: 0,
    leaveCredit: 0,
    workedOnHolidayCredit: 0,
    checkinSource,
    checkoutSource,
    markers,
  };
}
