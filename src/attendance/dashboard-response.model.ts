/**
 * 19-2's wire shapes (spec D5). The counts are answers to five separate
 * questions over the same engine grid rows — NOT partitions of `tracked`
 * (the documented overlap: a checked-in half_day_leave row counts in both
 * `checkedIn` and `onLeave`; the FE 19-4 tiles promise no summing
 * invariant).
 */

export interface DashboardCounts {
  /** Employees tracked today (grid rows where ctx.tracked). */
  tracked: number;
  /** Check-in instant today: in_progress | present | half_day |
   *  half_day_leave | worked_on_holiday (engine-authoritative — includes
   *  status-only overrides). A half_day_leave counts only with a check-in
   *  instant; rule 6 grades a never-appeared half-day leaver that status
   *  with NO check-in at all — leave, not a check-in. */
  checkedIn: number;
  /** status `not_checked_in_yet`. */
  notCheckedIn: number;
  /** outcome.isLate (never true on off-day statuses — the engine keeps
   *  Late null there). */
  late: number;
  /** status `leave` or `half_day_leave` (leaveCredit ≥ 0.5 today). */
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
