/**
 * The pure office-rule / weekly-off / daterange primitives of the
 * attendance day-status engine (extracted 21-1 from me-summary.model.ts +
 * enrolments-response.model.ts so the reports fetcher and the attendance
 * module share ONE implementation — the FR-11/15-9 anti-drift contract at
 * the type level; reports may not import feature modules, NFR5).
 *
 * No I/O, fully unit-testable. Dates are tenant-local `YYYY-MM-DD` keys
 * (AD-7); all arithmetic happens on those strings in UTC space.
 */

/** One `attendance_office_rules` row as the admin client returns it. */
export interface OfficeRuleRow {
  id: string;
  /** Postgres daterange literal, e.g. `[2026-09-27,)`. */
  valid: string;
  /** pg `time`, e.g. "10:00:00". */
  start_time: string;
  end_time: string;
  late_cutoff_minutes: number;
  /** Owner-configured grading thresholds, hours (G2-D1 ruling: these two
   *  columns ARE the full/half-day thresholds — window minutes only drive
   *  the late/early metrics). float8 from the SQL reads. */
  full_day_hours: number;
  half_day_hours: number;
}

/** One weekly-off defaults/overrides row (15-5 tables). */
export interface WeeklyOffRow {
  valid: string;
  /** ISO weekday numbers (1=Mon .. 7=Sun); [] = works all 7 days. */
  days: number[];
}

export interface DateRange {
  /** Inclusive lower bound, `YYYY-MM-DD`. */
  start: string;
  /** Exclusive upper bound, `YYYY-MM-DD`; `null` = unbounded (∞). */
  end: string | null;
}

/** Parses `[a,b)` / `[a,)` — the daterange text format pg returns. */
export function parseDateRange(valid: string): DateRange {
  const match = /^[(\[]([^,]*),([^)\]]*)[)\]]$/.exec(valid);
  if (!match || match[1] === '') {
    // An empty lower bound would silently poison the string-date
    // comparisons downstream (review finding).
    throw new Error(`Unparseable daterange literal: ${valid}`);
  }
  return { start: match[1], end: match[2] === '' ? null : match[2] };
}

/** True when the daterange literal contains the `YYYY-MM-DD` anchor. */
export function rangeCovers(valid: string, anchor: string): boolean {
  const { start, end } = parseDateRange(valid);
  return start <= anchor && (end === null || anchor < end);
}

/**
 * The rule effective on the anchor date (FR-5: rule changes apply from
 * tomorrow, so the covering rule is the display truth). The DB exclusion
 * constraint guarantees at most one rule covers any date — if none does,
 * the fields surface as nulls rather than a wrong rule.
 */
export function pickRuleForDate(
  rules: OfficeRuleRow[],
  anchor: string,
): OfficeRuleRow | null {
  return rules.find((rule) => rangeCovers(rule.valid, anchor)) ?? null;
}

/**
 * The employee's weekly offs on the anchor date: the override REPLACES the
 * tenant default while it covers the date (AD-22; an override with an
 * empty days array = works all 7 days). No covering override falls through
 * to the tenant defaults; NO defaults row at all means all 7 days work —
 * so [] in every "no weekly offs" case.
 */
export function pickWeeklyOffDays(
  overrides: WeeklyOffRow[],
  defaults: WeeklyOffRow[],
  anchor: string,
): number[] {
  const override = overrides.find((row) => rangeCovers(row.valid, anchor));
  if (override) {
    return [...override.days].sort((a, b) => a - b);
  }
  const def = defaults.find((row) => rangeCovers(row.valid, anchor));
  if (def) {
    return [...def.days].sort((a, b) => a - b);
  }
  return [];
}
