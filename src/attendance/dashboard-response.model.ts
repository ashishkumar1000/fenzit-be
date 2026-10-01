/**
 * 19-2's wire shapes (spec D5). On TODAY the tiles PARTITION `tracked`
 * (the 2026-10-01 user ruling — checkedIn + notCheckedIn + onLeave must
 * add up to tracked): every tracked row lands in exactly one bucket,
 * keyed by the OUTCOME STATUS — the same grade the calendar cell and the
 * day sheet show (the 19-2 module header's tile/calendar invariant).
 * `late` is not a fourth bucket — it counts only inside `checkedIn`.
 */

export interface DashboardCounts {
  /** Employees tracked today (grid rows where ctx.tracked). */
  tracked: number;
  /** A presence grade — in_progress | present | half_day |
   *  worked_on_holiday (the calendar says these people reported).
   *  Includes a rule-1 status-only `present`/`half_day` override even
   *  where no punch landed, and excludes an owner-adjudicated `absent`
   *  override (that reads notCheckedIn) — the bucket follows the
   *  owner's grade, never the raw punches. */
  checkedIn: number;
  /** Everything not checked-in-or-leave: not_checked_in_yet |
   *  weekly_off | holiday | absent — engine-graded (a sub-half-day
   *  punch-in/out, below D5's half-day threshold) or owner-adjudicated;
   *  the tile's question is "who hasn't reported". */
  notCheckedIn: number;
  /** outcome.isLate among the checkedIn rows only (the engine keeps
   *  Late null wherever there is no check-in instant, so late is a
   *  qualifier of checkedIn — never a fourth bucket). */
  late: number;
  /** A leave grade — leave | half_day_leave (the leave credit stays a
   *  day-sheet/summary truth; the tile reads the person "on leave"). */
  onLeave: number;
}

/** A past tracked day with a check-in and no check-out (engine rule 8). */
export interface CheckoutMissingFlagRow {
  employeeId: string;
  employeeName: string;
  /** Tenant-local `YYYY-MM-DD`. */
  workDate: string;
  /** The office of the assignment covering the FLAG date (may have moved). */
  officeName: string | null;
}

/** Unacknowledged mocked attempts, grouped per employee-date (AD-10). */
export interface FakeLocationFlagRow {
  employeeId: string;
  employeeName: string;
  /** Tenant-local `YYYY-MM-DD` of the attempts. */
  workDate: string;
  officeName: string | null;
  attemptCount: number;
}

/** An office of the picker registry with today's stats (19-4 redesign) —
 *  every non-archived attendance office, tracked/checkedIn over the FULL
 *  tenant scope (never the fetch's filter — the picker must list every
 *  office with its own truth). */
export interface DashboardOfficeRow {
  id: string;
  name: string;
  tracked: number;
  checkedIn: number;
}

export interface DashboardResponse {
  /** The tile date — `attendance_today()`'s tenant-local YYYY-MM-DD. */
  date: string;
  counts: DashboardCounts;
  /** The office registry with today's stats — the office picker's rows. */
  offices: DashboardOfficeRow[];
  flags: {
    checkoutMissing: CheckoutMissingFlagRow[];
    fakeLocationAttempt: FakeLocationFlagRow[];
  };
}
