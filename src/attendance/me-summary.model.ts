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

export interface MeSummaryResponse {
  officeId: string | null;
  officeName: string | null;
  /** `HH:mm` (the wire convention; 12-hour rendering is the app's). */
  startTime: string | null;
  endTime: string | null;
  lateCutOffMinutes: number | null;
  /** ISO weekday numbers sorted ascending; [] = no weekly offs. */
  weeklyOffDays: number[];
  /** Office pin for the Today screen's display-only distance hint (16-4). */
  officeLatitude: number | null;
  officeLongitude: number | null;
  /** Today's day facts (16-4) — active ONLY, null otherwise. Built in
   *  me-summary-today.model (the cycle-free layer above day-context). */
  today: TodayFacts | null;
  /** Today's record (16-4) — active ONLY, null when no record today. */
  todayRecord: TodayRecordView | null;
}

/** Today's day facts (active employees only). Implemented in
 *  me-summary-today.model — declared here so the response shape stays the
 *  one definition this module owns. */
export interface TodayFacts {
  /** `YYYY-MM-DD` tenant-local (the server's today, AD-7). */
  date: string;
  isWeeklyOff: boolean;
  isHoliday: boolean;
  holidayName: string | null;
  isWorkingDay: boolean;
  /**
   * Today's ACTIVE leave (17-8 D1): the AD-22 seam mirrored on the
   * summary — `'pending' | 'approved'` when a `leave_request_days` row
   * covers today in a live state, else null (cancelled/revoked/no leave
   * all read null — exactly the shape the D11 gate already handles).
   * Named byte-parity with day-context's own fields.
   */
  leaveState: 'pending' | 'approved' | null;
  /** The covering request's part (DB CHECK enum); null with leaveState. */
  leavePart: 'full_day' | 'first_half' | 'second_half' | null;
}

/** The day's record as the Today screen renders it (mirror of the
 *  check-in/out response fields; instants carry the tenant offset). */
export interface TodayRecordView {
  checkinAt: string;
  checkoutAt: string | null;
  lateMinutes: number | null;
  isLate: boolean;
  workedMinutes: number | null;
  earlyCheckout: boolean | null;
  earlyCheckoutMinutes: number | null;
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
  officePin: { latitude: number; longitude: number } | null;
  today: TodayFacts | null;
  todayRecord: TodayRecordView | null;
}): MeSummaryResponse {
  return {
    officeId: input.row.office_id,
    officeName: input.row.office_name,
    startTime: input.rule ? toHhmm(input.rule.start_time) : null,
    endTime: input.rule ? toHhmm(input.rule.end_time) : null,
    lateCutOffMinutes: input.rule ? input.rule.late_cutoff_minutes : null,
    weeklyOffDays: input.weeklyOffDays,
    officeLatitude: input.officePin ? input.officePin.latitude : null,
    officeLongitude: input.officePin ? input.officePin.longitude : null,
    today: input.today,
    todayRecord: input.todayRecord,
  };
}

/** The honest empty for states the endpoint is not defined for. Frozen —
 *  every honest-empty 200 returns THE SAME object by reference, so a stray
 *  mutation would poison all later responses process-wide. */
export const EMPTY_ME_SUMMARY: MeSummaryResponse = Object.freeze({
  officeId: null,
  officeName: null,
  startTime: null,
  endTime: null,
  lateCutOffMinutes: null,
  weeklyOffDays: Object.freeze([]) as unknown as number[],
  officeLatitude: null,
  officeLongitude: null,
  today: null,
  todayRecord: null,
});
