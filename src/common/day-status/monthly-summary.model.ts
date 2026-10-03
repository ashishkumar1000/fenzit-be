/**
 * 19-3's monthly aggregation — pure arithmetic over the day-status engine's
 * grid rows (day-status.read.ts's readDayStatusGrid + computeDayStatus).
 * The FR-11 contract: every aggregate is derived from the SAME per-day
 * outcomes the calendar and the day sheet show — a summary cell can never
 * disagree with a day cell (the 15-9 drift class stays closed).
 *
 * Tracked rows only: `ctx.tracked` (rule 2 already drops untracked rows'
 * credits to zero, but excluding them here keeps `weeklyOffs`/`holidays`
 * honest for dates outside the tracker too).
 */

import type { DayGridRow } from './grid-reader';
import {
  computeDayStatus,
  type DayStatusOutcome,
} from './day-status.model';

/** The spec-19 D6 tile set, summed over one employee's tracked rows. */
export interface MonthlyEmployeeSummary {
  /** Σ outcome.daysWorked (half-day-leave earned halves included). */
  daysWorked: number;
  /** Days graded exactly `half_day` (rule 6's sibling statuses excluded). */
  halfDays: number;
  /** Days whose outcome flags isLate. */
  lateCount: number;
  /** Σ outcome.leaveCredit (approved full = 1, approved half = 0.5). */
  leave: number;
  /** Days graded `weekly_off` (worked ones read worked_on_holiday). */
  weeklyOffs: number;
  /** Days graded `holiday` without a check-in. */
  holidays: number;
  /** Σ outcome.workedOnHolidayCredit. */
  workedOnHoliday: number;
  /** Days graded `absent` (rule 9 only — not not_tracked, not off-days). */
  absent: number;
  /** Past rows with a check-in and no check-out, in any grading. */
  checkoutMissing: number;
}

/** Sums one employee's tracked grid rows into their monthly summary. */
export function summariseEmployeeMonth(
  rows: DayGridRow[],
): MonthlyEmployeeSummary {
  const summary: MonthlyEmployeeSummary = {
    daysWorked: 0,
    halfDays: 0,
    lateCount: 0,
    leave: 0,
    weeklyOffs: 0,
    holidays: 0,
    workedOnHoliday: 0,
    absent: 0,
    checkoutMissing: 0,
  };
  for (const row of rows) {
    if (!row.ctx.tracked) continue;
    const outcome = outcomeFor(row);
    summary.daysWorked += outcome.daysWorked;
    if (outcome.status === 'half_day') summary.halfDays += 1;
    if (outcome.isLate) summary.lateCount += 1;
    summary.leave += outcome.leaveCredit;
    if (outcome.status === 'weekly_off') summary.weeklyOffs += 1;
    if (outcome.status === 'holiday') summary.holidays += 1;
    summary.workedOnHoliday += outcome.workedOnHolidayCredit;
    if (outcome.status === 'absent') summary.absent += 1;
    if (outcome.markers.includes('checkout_missing')) {
      summary.checkoutMissing += 1;
    }
  }
  // Credit maths produces 0.5 steps — snap float drift before it lands on
  // the wire (0.30000000000000004 is a wire-visible difference).
  for (const key of ['daysWorked', 'leave', 'workedOnHoliday'] as const) {
    summary[key] = round1(summary[key]);
  }
  return summary;
}

function outcomeFor(row: DayGridRow): DayStatusOutcome {
  return computeDayStatus({
    ctx: row.ctx,
    record: row.record,
    override: row.override,
    hasUnackMockedAttempt: row.hasUnackMockedAttempt,
    today: row.today,
  });
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
