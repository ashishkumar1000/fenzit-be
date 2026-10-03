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

// The rule rows + the daterange pickers live in common/day-status
// (21-1 extraction) — re-exported so this model's consumers keep one
// import surface while the engine shares ONE implementation (NFR5).
import {
  rangeCovers as rangeCoversShared,
  pickRuleForDate as pickRuleForDateShared,
  pickWeeklyOffDays as pickWeeklyOffDaysShared,
  type OfficeRuleRow,
  type WeeklyOffRow,
} from '../common/day-status/office-rules';

export type { OfficeRuleRow, WeeklyOffRow };

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
  /** The office's geofence radius in metres (20-3) — the SAME value the
   *  check-in/out gates read server-side. Display/prescreen input only:
   *  the server remains authoritative for every punch, so a client-side
   *  lock must NEVER reject on its own. */
  officeRadius: number | null;
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

export const rangeCovers = rangeCoversShared;
export const pickRuleForDate = pickRuleForDateShared;
export const pickWeeklyOffDays = pickWeeklyOffDaysShared;

export function toMeSummaryResponse(input: {
  row: Pick<AccessStateRow, 'office_id' | 'office_name'>;
  rule: OfficeRuleRow | null;
  weeklyOffDays: number[];
  officePin:
    | { latitude: number; longitude: number; radius_m: number | null }
    | null;
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
    // The office's radius_m passes straight through (null column → null
    // field — the FE fail-opens on a null/absent radius).
    officeRadius: input.officePin ? input.officePin.radius_m : null,
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
  officeRadius: null,
  today: null,
  todayRecord: null,
});
