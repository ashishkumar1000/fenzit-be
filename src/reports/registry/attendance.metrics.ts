import type { DayGridRow } from '../../common/day-status/grid-reader';
import {
  computeDayStatus,
  type DayStatusOutcome,
  type DayStatusKey,
} from '../../common/day-status/day-status.model';
import {
  summariseEmployeeMonth,
  type MonthlyEmployeeSummary,
} from '../../common/day-status/monthly-summary.model';

/**
 * Attendance-report aggregations (21-2) — pure arithmetic over the shared
 * grid reader's rows. The FR-11 parity contract made structural: the nine
 * summary numbers come from `summariseEmployeeMonth` — THE SAME function
 * the in-app monthly grid uses — so a PDF cell can never disagree with an
 * app cell. Everything here adds report-only derivations (hours, late
 * minutes, expected days, rate) on top of the same per-day outcomes.
 *
 * Formula set is normative per spec report-content.md:
 *  - expected working days = tracked days − weekly offs − holidays
 *    (no check-in) − approved leave credits (owner-confirmed: leave stays
 *    OUT of the denominator);
 *  - attendance rate = Σ daysWorked ÷ Σ expected (1 decimal; "—" when
 *    expected = 0);
 *  - worked hours sum non-null workedMinutes only (open/missing-checkout
 *    days contribute nothing — their count is visible next to it).
 */

/** One employee/office/overall/week aggregate — the report's row unit. */
export interface AttendanceSummary extends MonthlyEmployeeSummary {
  /** Grid rows whose enrolment covers the date (the tracked-day count). */
  trackedDays: number;
  /** Days graded exactly `present` (full-day work; half-day-leave earned
   *  halves and half days are NOT included — see halfDays). */
  fullDays: number;
  /** Σ lateMinutes over rows flagged late (suppressed on off-days by the engine). */
  lateMinutes: number;
  /** Rows flagged early-checkout against the rule's expected end. */
  earlyOuts: number;
  /** Σ non-null workedMinutes (open/missing-checkout days contribute 0). */
  workedMinutesTotal: number;
  /** Rows carrying a 'corrected' marker (a manual override shaped the day). */
  corrections: number;
  /** Rows carrying a 'fake_location_attempt' marker (UNACKNOWLEDGED only —
   *  acknowledged attempts stay in the attempts audit, per owner ruling). */
  fakeLocationDays: number;
  /** Rows whose covering leave day is still pending. */
  pendingLeaveDays: number;
  /** Rows graded half_day_leave (an approved part-day leave actually worked). */
  halfDayLeaves: number;
  /** trackedDays − weeklyOffs − holidays − leave credits (rate denominator). */
  expectedDays: number;
  /** daysWorked ÷ expectedDays × 100, 1 decimal; null when expected = 0. */
  attendanceRate: number | null;
  /** workedMinutesTotal ÷ 60, 1 decimal (0 stays 0 — an honest zero). */
  workedHours: number;
  /** workedHours ÷ days WITH a worked span (a half-day credit is 0.5 of a
   *  day but a full day of hours — dividing by credit made the average
   *  read DOUBLE the total; bug bash 2026-10-03, owner-persona round).
   *  Null when no day carries a span. */
  avgHoursPerDay: number | null;
}

/** The engine outcome for one grid row — THE one call site for the report. */
export function attendanceOutcome(row: DayGridRow): DayStatusOutcome {
  return computeDayStatus({
    ctx: row.ctx,
    record: row.record,
    override: row.override,
    hasUnackMockedAttempt: row.hasUnackMockedAttempt,
    today: row.today,
  });
}

/** Sums one employee's (or any scope's) tracked grid rows into the report row. */
export function summariseAttendanceRange(
  rows: DayGridRow[],
): AttendanceSummary {
  // The nine numbers ride the app's own aggregation — parity by construction.
  const nine = summariseEmployeeMonth(rows);
  const extra = {
    trackedDays: 0,
    fullDays: 0,
    lateMinutes: 0,
    earlyOuts: 0,
    workedMinutesTotal: 0,
    daysWithHours: 0,
    corrections: 0,
    fakeLocationDays: 0,
    pendingLeaveDays: 0,
    halfDayLeaves: 0,
  };
  for (const row of rows) {
    if (!row.ctx.tracked) continue;
    extra.trackedDays += 1;
    const outcome = attendanceOutcome(row);
    if (outcome.status === 'present') extra.fullDays += 1;
    extra.lateMinutes += outcome.lateMinutes ?? 0;
    if (outcome.earlyCheckout) extra.earlyOuts += 1;
    // A same-instant punch yields workedMinutes 0 — it is not a day
    // "with hours" and must not dilute the average (review 2026-10-03).
    if (outcome.workedMinutes != null && outcome.workedMinutes > 0) {
      extra.workedMinutesTotal += outcome.workedMinutes;
      extra.daysWithHours += 1;
    }
    if (row.override) extra.corrections += 1;
    if (outcome.markers.includes('fake_location_attempt')) {
      extra.fakeLocationDays += 1;
    }
    if (row.ctx.leaveState === 'pending') extra.pendingLeaveDays += 1;
    if (outcome.status === 'half_day_leave') extra.halfDayLeaves += 1;
  }
  return finalise(nine, extra);
}

/** The nine + extras → derived rates/hours, float drift snapped (19-3 rule). */
function finalise(
  nine: MonthlyEmployeeSummary,
  extra: Omit<
    AttendanceSummary,
    | keyof MonthlyEmployeeSummary
    | 'expectedDays'
    | 'attendanceRate'
    | 'workedHours'
    | 'avgHoursPerDay'
  > & {
    /** Internal counter: tracked days carrying a real worked span. */
    daysWithHours: number;
  },
): AttendanceSummary {
  // Leave credits stay OUT of the expected-day denominator (owner ruling).
  const expectedDays = Math.max(
    0,
    extra.trackedDays - nine.weeklyOffs - nine.holidays - nine.leave,
  );
  const workedHours = round1(extra.workedMinutesTotal / 60);
  return {
    ...nine,
    ...extra,
    expectedDays,
    attendanceRate:
      expectedDays > 0 ? round1((nine.daysWorked / expectedDays) * 100) : null,
    workedHours,
    avgHoursPerDay:
      extra.daysWithHours > 0
        ? round1(extra.workedMinutesTotal / 60 / extra.daysWithHours)
        : null,
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** The register's single-character day codes (spec report-content.md). */
const REGISTER_CODES: Record<DayStatusKey, string> = {
  present: 'P',
  half_day: 'H',
  absent: 'A',
  leave: 'L',
  half_day_leave: 'Hl',
  worked_on_holiday: 'W',
  weekly_off: 'O',
  holiday: '★',
  checkout_missing: 'M',
  not_tracked: '·',
  not_checked_in_yet: '·',
  in_progress: '·',
};

export function registerCode(status: DayStatusKey): string {
  return REGISTER_CODES[status];
}

/** Needs-attention kinds, severities fixed per kind (template maps colour). */
export type AttendanceExceptionKind =
  | 'fake_location'
  | 'missing_checkout'
  | 'absent_streak'
  | 'repeat_late'
  | 'corrected';

export interface AttendanceException {
  kind: AttendanceExceptionKind;
  severity: 'alarm' | 'warning' | 'info';
  employeeName: string;
  /** Pre-rendered one-liner (the template does zero attendance math). */
  title: string;
  detail: string;
}

const EXCEPT_CAP_DATES = 6;

/** "30 Sep, 01 Oct" from up to 6 dates + an overflow suffix. */
function dateList(dates: string[]): string {
  const shown = dates.slice(0, EXCEPT_CAP_DATES);
  const rest = dates.length - shown.length;
  const label = `${shown.join(', ')}${rest > 0 ? ` +${rest} more` : ''}`;
  return label;
}

/**
 * Needs-attention rows from the same outcomes the tables show. Deterministic
 * order: alarms → warnings → infos, then employee name, then first date.
 */
export function computeAttendanceExceptions(
  rows: DayGridRow[],
  employeesById: Map<string, { name: string }>,
): AttendanceException[] {
  const byEmployee = new Map<string, DayGridRow[]>();
  for (const row of rows) {
    if (!row.ctx.tracked) continue;
    const list = byEmployee.get(row.employeeId) ?? [];
    list.push(row);
    byEmployee.set(row.employeeId, list);
  }

  const out: AttendanceException[] = [];
  for (const [employeeId, employeeRows] of byEmployee) {
    const name = employeesById.get(employeeId)?.name ?? employeeId;
    const sorted = [...employeeRows].sort((a, b) =>
      a.workDate < b.workDate ? -1 : 1,
    );

    // Unacknowledged fake-location attempts — the fraud alarm.
    const fakeDates = sorted
      .filter((r) => r.hasUnackMockedAttempt)
      .map((r) => r.workDate);
    if (fakeDates.length > 0) {
      out.push({
        kind: 'fake_location',
        severity: 'alarm',
        employeeName: name,
        title: 'Fake-location attempt',
        detail: `${fakeDates.length} day${fakeDates.length === 1 ? '' : 's'} with fake-location attempts — ${dateList(fakeDates)}`,
      });
    }

    // Missing check-outs — payroll blockers.
    const missingDates = sorted
      .filter((r) => attendanceOutcome(r).markers.includes('checkout_missing'))
      .map((r) => r.workDate);
    if (missingDates.length > 0) {
      out.push({
        kind: 'missing_checkout',
        severity: 'warning',
        employeeName: name,
        title: 'Missing check-out',
        detail: `${missingDates.length} day${missingDates.length === 1 ? '' : 's'} never checked out — ${dateList(missingDates)}`,
      });
    }

    // Absent streaks ≥ 3 consecutive expected days (rule-9 absents only).
    let streak: string[] = [];
    const flushStreak = () => {
      if (streak.length >= 3) {
        out.push({
          kind: 'absent_streak',
          severity: 'alarm',
          employeeName: name,
          title: 'Absent streak',
          detail: `${streak.length} consecutive days absent — ${streak[0]} to ${streak[streak.length - 1]}`,
        });
      }
      streak = [];
    };
    for (const row of sorted) {
      if (attendanceOutcome(row).status === 'absent') {
        streak.push(row.workDate);
      } else {
        flushStreak();
      }
    }
    flushStreak();

    // Repeat lateness (≥ 3 late days in range).
    const lateDates = sorted
      .filter((r) => attendanceOutcome(r).isLate)
      .map((r) => r.workDate);
    if (lateDates.length >= 3) {
      out.push({
        kind: 'repeat_late',
        severity: 'warning',
        employeeName: name,
        title: 'Repeatedly late',
        detail: `Late on ${lateDates.length} days — ${dateList(lateDates)}`,
      });
    }

    // Corrections applied — informational.
    const correctedDates = sorted
      .filter((r) => r.override)
      .map((r) => r.workDate);
    if (correctedDates.length > 0) {
      out.push({
        kind: 'corrected',
        severity: 'info',
        employeeName: name,
        title: 'Attendance corrected',
        detail: `${correctedDates.length} day${correctedDates.length === 1 ? '' : 's'} corrected by the owner — ${dateList(correctedDates)}`,
      });
    }
  }

  const severityRank = { alarm: 0, warning: 1, info: 2 } as const;
  return out.sort(
    (a, b) =>
      severityRank[a.severity] - severityRank[b.severity] ||
      a.employeeName.localeCompare(b.employeeName) ||
      a.detail.localeCompare(b.detail),
  );
}
