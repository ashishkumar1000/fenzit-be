/**
 * Pure model for GET /attendance/me/summary (15-10) — no I/O, fully
 * unit-testable.
 *
 * The FR-4 summary (Office, Start/End time, Late cut-off, Weekly offs) for
 * `active`/`upcoming` employees. The service reads the employee's
 * `attendance_access_state` VIEW ROW and takes officeId AND the anchor date
 * from it — one anchor implementation shared with me/access, so the summary
 * can never disagree with the tab's state about WHICH office applies
 * (spec-15-10 review finding #8: hand-rolling the anchor in new SQL would
 * recreate the 15-9 drift defect class). Only the rule/weekly-off
 * selection below is new logic.
 *
 * Times travel as HH:mm per the API convention (the 15-10 spec decision:
 * NFR-5's 12-hour display is the app's formatting job).
 */
import type { AccessStateRow } from './enrolments-response.model';
import { parseDateRange } from './enrolments-response.model';

/** One `attendance_office_rules` row as the admin client returns it. */
export interface OfficeRuleRow {
  id: string;
  /** Postgres daterange literal, e.g. `[2026-09-27,)`. */
  valid: string;
  /** pg `time`, e.g. "10:00:00". */
  start_time: string;
  end_time: string;
  late_cutoff_minutes: number;
}

/** One weekly-off defaults/overrides row (15-5 tables). */
export interface WeeklyOffRow {
  valid: string;
  /** ISO weekday numbers (1=Mon .. 7=Sun); [] = works all 7 days. */
  days: number[];
}

export interface MeSummaryResponse {
  officeId: string | null;
  officeName: string | null;
  /** `HH:mm` (the wire convention; 12-hour rendering is the app's). */
  startTime: string | null;
  endTime: string | null;
  lateCutOffMinutes: number | null;
  /** ISO weekday numbers sorted ascending; [] = no weekly offs. */
  weeklyOffDays: number[];
}

/** The endpoint serves the two states that have an anchored office. */
export function isSummarisableState(
  state: AccessStateRow['access_state'],
): boolean {
  return state === 'active' || state === 'upcoming';
}

/** "10:00:00" → "10:00" (times travel as HH:mm per the API convention). */
function toHhmm(value: string): string {
  return value.slice(0, 5);
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

export function toMeSummaryResponse(input: {
  row: Pick<AccessStateRow, 'office_id' | 'office_name'>;
  rule: OfficeRuleRow | null;
  weeklyOffDays: number[];
}): MeSummaryResponse {
  return {
    officeId: input.row.office_id,
    officeName: input.row.office_name,
    startTime: input.rule ? toHhmm(input.rule.start_time) : null,
    endTime: input.rule ? toHhmm(input.rule.end_time) : null,
    lateCutOffMinutes: input.rule ? input.rule.late_cutoff_minutes : null,
    weeklyOffDays: input.weeklyOffDays,
  };
}

/** The honest empty for states the endpoint is not defined for. */
export const EMPTY_ME_SUMMARY: MeSummaryResponse = {
  officeId: null,
  officeName: null,
  startTime: null,
  endTime: null,
  lateCutOffMinutes: null,
  weeklyOffDays: [],
};
