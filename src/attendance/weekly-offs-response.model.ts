import { parseRuleRange } from './offices-response.model';

/**
 * attendance_weekly_off_defaults / attendance_weekly_off_overrides row
 * (snake_case, DB shape). Overrides additionally carry employee_id.
 */
export interface WeeklyOffRow {
  id: string;
  tenant_id: string;
  employee_id?: string;
  /** PostgREST serialises daterange as e.g. "[2026-09-26,)". */
  valid: string;
  days: number[];
  created_at: string;
  updated_at: string;
}

/** One effective-dated weekly-off selection, bounds as "YYYY-MM-DD". */
export interface WeeklyOffView {
  /** ISO weekday numbers (1=Mon .. 7=Sun), sorted ascending. */
  days: number[];
  /** Inclusive start date of the validity range. */
  validFrom: string;
  /** Exclusive end date, or null while the range is open-ended. */
  validTo: string | null;
}

/**
 * GET /attendance/weekly-offs and the PUT response — the tenant default:
 * `default` is the selection valid on today (null = all 7 days working,
 * including the never-configured case), `next` the earliest future edit,
 * `history` the full effective-dated past, ascending.
 */
export interface WeeklyOffDefaultResponse {
  default: WeeklyOffView | null;
  next: WeeklyOffView | null;
  history: WeeklyOffView[];
}

/**
 * GET /attendance/weekly-offs/overrides — each employee with an override
 * range, the selection valid today and a pending future edit. Employees
 * without an override row are absent (they read the tenant default).
 */
export interface WeeklyOffOverrideResponse {
  employeeId: string;
  employeeName: string;
  current: WeeklyOffView | null;
  next: WeeklyOffView | null;
}

export function toWeeklyOffView(row: WeeklyOffRow): WeeklyOffView {
  const { from, to } = parseRuleRange(row.valid);
  return {
    days: [...row.days].sort((a, b) => a - b),
    validFrom: from,
    validTo: to,
  };
}

/** Rows sorted by validFrom ascending (history order). */
export function sortWeeklyOffRows(rows: WeeklyOffRow[]): WeeklyOffRow[] {
  return [...rows].sort((a, b) =>
    parseRuleRange(a.valid).from.localeCompare(parseRuleRange(b.valid).from),
  );
}

/**
 * The range whose validity contains `today` (a YYYY-MM-DD string from
 * attendance_today — the only source of "today", AD-7). The recorded
 * fetch-and-pick deviation: PostgREST's range operators cannot express
 * element containment, so the pick happens on the fetched rows.
 */
export function pickCurrentWeeklyOff(
  rows: WeeklyOffRow[],
  today: string,
): WeeklyOffRow | null {
  return (
    rows.find((r) => {
      const { from, to } = parseRuleRange(r.valid);
      return from <= today && (to === null || today < to);
    }) ?? null
  );
}

/** The earliest range starting after today (a pending edit). */
export function pickNextWeeklyOff(
  rows: WeeklyOffRow[],
  today: string,
): WeeklyOffRow | null {
  const future = sortWeeklyOffRows(
    rows.filter((r) => parseRuleRange(r.valid).from > today),
  );
  return future[0] ?? null;
}

/** Full history as views, ascending — includes current and next. */
export function toWeeklyOffHistory(rows: WeeklyOffRow[]): WeeklyOffView[] {
  return sortWeeklyOffRows(rows).map(toWeeklyOffView);
}
