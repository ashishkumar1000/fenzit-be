/**
 * Pure model for the enrolment routes (15-7) — no I/O, fully unit-testable.
 *
 * Two halves:
 *  1. The AD-8 effective-dated algorithm over `[start, end)` ranges
 *     (`end = null` is unbounded/∞): delete future → clip covering →
 *     insert. The repository executes the returned plan; this file decides
 *     it, so the algorithm is pinned by tests rather than buried in SQL.
 *  2. Mapping of `attendance_access_state` view rows (snake_case, as pg and
 *     the admin client return them) to the API shapes.
 *
 * Dates are tenant-local `YYYY-MM-DD` keys (AD-7); all arithmetic happens
 * on those strings in UTC space — never on device/`Date` local time.
 */

export interface EnrolmentRow {
  id: string;
  /** Postgres daterange literal, e.g. `[2026-09-27,)`. */
  valid: string;
  enabled_at?: string;
}

export interface DateRange {
  /** Inclusive lower bound, `YYYY-MM-DD`. */
  start: string;
  /** Exclusive upper bound, `YYYY-MM-DD`; `null` = unbounded (∞). */
  end: string | null;
}

/** The plan the repository executes for one AD-8 change. */
export interface Ad8Plan {
  deleteIds: string[];
  clipId: string | null;
  /** New exclusive upper bound for the covering range (when clipped). */
  clipEnd: string | null;
  /** Lower bound of the inserted `[effective_from, ∞)` row, when inserting. */
  insertStart: string | null;
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

export function serializeDateRange(range: DateRange): string {
  return `[${range.start},${range.end ?? ''})`;
}

/** `YYYY-MM-DD` + n days, in UTC space (no DST in date-only space). */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + n));
  return shifted.toISOString().slice(0, 10);
}

/**
 * AD-8 steps 2–4 for one owner key: ranges starting on/after
 * `effectiveFrom` are deleted, the covering range's upper bound is clipped
 * to `effectiveFrom`, and — unless `insert` is false (disable) — a new
 * `[effectiveFrom, ∞)` row is inserted. Step 1 (the
 * `greatest(p_from, today)` clamp) happens in the service.
 */
export function planAd8Change(
  rows: EnrolmentRow[],
  effectiveFrom: string,
  insert: boolean,
): Ad8Plan {
  const parsed = rows.map((row) => ({
    id: row.id,
    range: parseDateRange(row.valid),
  }));

  const deleteIds = parsed
    .filter(({ range }) => range.start >= effectiveFrom)
    .map(({ id }) => id);

  // The covering range contains effectiveFrom; rows starting exactly on
  // effectiveFrom were already deleted, so the clip can never empty it
  // (the NOT isempty CHECK holds).
  const covering = parsed.find(
    ({ id, range }) =>
      !deleteIds.includes(id) &&
      range.start < effectiveFrom &&
      (range.end === null || range.end > effectiveFrom),
  );

  return {
    deleteIds,
    clipId: covering?.id ?? null,
    clipEnd: covering ? effectiveFrom : null,
    insertStart: insert ? effectiveFrom : null,
  };
}

/** The `attendance_access_state` view row (snake_case) as pg/the admin return it. */
export interface AccessStateRow {
  user_id: string;
  tenant_id: string;
  attendance_enabled: boolean;
  access_state: 'none' | 'upcoming' | 'active' | 'history_only';
  attendance_start_date: string | null;
  enabled_at: string | null;
  onboarded_at: string | null;
  office_id: string | null;
  office_name: string | null;
}

export interface AccessStateResponse {
  attendanceEnabled: boolean;
  attendanceAccess: 'none' | 'upcoming' | 'active' | 'history_only';
  attendanceStartDate: string | null;
  /** `enabled_at` of the period covering today (null when not active). */
  enabledAt: string | null;
  onboardedAt: string | null;
  officeId: string | null;
  officeName: string | null;
}

export function toAccessStateResponse(
  row: AccessStateRow,
): AccessStateResponse {
  return {
    attendanceEnabled: row.attendance_enabled,
    attendanceAccess: row.access_state,
    attendanceStartDate: row.attendance_start_date,
    enabledAt: row.enabled_at,
    onboardedAt: row.onboarded_at,
    officeId: row.office_id,
    officeName: row.office_name,
  };
}

/** Owner-roster row (view row + the users-table display fields). */
export interface EnrolmentOverviewResponse extends AccessStateResponse {
  employeeId: string;
  employeeName: string;
  phone: string;
}
