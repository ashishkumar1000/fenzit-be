/**
 * Pure model for the FR-4 summary's "today" extension (16-4 batch): the
 * day facts and the day's record the technician's Today screen renders —
 * pre-flight dialog input (weekly off / holiday), the button's on-load
 * state, and the done card's numbers.
 *
 * Why a separate file: `day-context.ts` imports its rule/weekly-off
 * pickers from `me-summary.model.ts`, so me-summary.model cannot import
 * back without a cycle. This module sits ABOVE both (it may import
 * day-context's math one-way) and is the only new logic; me-summary.model
 * keeps the response shape, this file keeps the building of it.
 *
 * Every piece of the math is IMPORTED from day-context (AD-22: one
 * implementation) — nothing here re-derives a weekday, a late grade or a
 * worked-minute count.
 */
import type {
  OfficeRuleRow,
  TodayFacts,
  TodayRecordView,
} from './me-summary.model';
import {
  computeEarlyCheckoutMinutes,
  computeLateMinutes,
  isWeeklyOffDay,
  minuteOfDayInTz,
  timeStringToMinutes,
  workedMinutesBetween,
} from '../common/day-status/day-context';
import { toTenantOffsetIso } from './check-in-out.model';

/** The summary read's attendance_records row (subset). */
export interface SummaryRecordRow {
  work_date: string;
  checkin_at: Date | string;
  checkout_at: Date | string | null;
}

/**
 * Today's facts from already-picked rows: the weekly-off set is the
 * override-aware set `pickWeeklyOffDays` returned for the same date, so
 * the facts can never disagree with the summary's own `weeklyOffDays`.
 */
/** The summary read's active-leave row (17-8 D1) — the DB CHECK enums
 *  narrow here; the service passes what `readTodayLeave` returned. */
export interface SummaryLeaveRow {
  state: 'pending' | 'approved';
  part: 'full_day' | 'first_half' | 'second_half';
}

export function pickTodayFacts(
  weeklyOffDays: number[],
  holidayName: string | null,
  date: string,
  leave: SummaryLeaveRow | null = null,
): TodayFacts {
  const isWeeklyOff = isWeeklyOffDay(weeklyOffDays, date);
  const isHoliday = holidayName !== null;
  return {
    date,
    isWeeklyOff,
    isHoliday,
    holidayName,
    isWorkingDay: !isWeeklyOff && !isHoliday,
    // The leave facts ride the SAME null-otherwise contract as the
    // today extension itself: no live leave row -> both null (17-8 D1).
    leaveState: leave?.state ?? null,
    leavePart: leave?.part ?? null,
  };
}

/** The record view for an OPEN day (checked in, not yet out). */
export function openRecordView(
  record: SummaryRecordRow,
  timezone: string,
  rule: OfficeRuleRow | null,
): TodayRecordView {
  const lateMinutes = rule
    ? computeLateMinutes(
        minuteOfDayInTz(new Date(record.checkin_at), timezone),
        timeStringToMinutes(rule.start_time),
        rule.late_cutoff_minutes,
      )
    : null;
  return {
    checkinAt: toTenantOffsetIso(new Date(record.checkin_at), timezone),
    checkoutAt: null,
    lateMinutes,
    isLate: lateMinutes !== null && lateMinutes > 0,
    workedMinutes: null,
    earlyCheckout: null,
    earlyCheckoutMinutes: null,
  };
}

/** The record view for a CLOSED day (checked in and out). */
export function closedRecordView(
  record: SummaryRecordRow & { checkout_at: Date | string },
  timezone: string,
  rule: OfficeRuleRow | null,
): TodayRecordView {
  const lateMinutes = rule
    ? computeLateMinutes(
        minuteOfDayInTz(new Date(record.checkin_at), timezone),
        timeStringToMinutes(rule.start_time),
        rule.late_cutoff_minutes,
      )
    : null;
  const earlyCheckoutMinutes = rule
    ? computeEarlyCheckoutMinutes(
        minuteOfDayInTz(new Date(record.checkout_at), timezone),
        timeStringToMinutes(rule.end_time),
      )
    : null;
  return {
    checkinAt: toTenantOffsetIso(new Date(record.checkin_at), timezone),
    checkoutAt: toTenantOffsetIso(new Date(record.checkout_at), timezone),
    lateMinutes,
    isLate: lateMinutes !== null && lateMinutes > 0,
    workedMinutes: workedMinutesBetween(record.checkin_at, record.checkout_at),
    earlyCheckout: earlyCheckoutMinutes !== null,
    earlyCheckoutMinutes,
  };
}
