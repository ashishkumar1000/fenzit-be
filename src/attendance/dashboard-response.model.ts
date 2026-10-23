/**
 * 19-2's wire shapes (spec D5). On TODAY the tiles PARTITION `tracked`
 * (the FOUR buckets — checkedIn + notCheckedIn + onLeave + shortDay must
 * add up to tracked, story 20-2; rows move, never copy): every tracked
 * row lands in exactly one bucket, keyed by the OUTCOME STATUS — the
 * same grade the calendar cell and the day sheet show (the 19-2 module
 * header's tile/calendar invariant). `late` is not a bucket — it counts
 * only inside `checkedIn`.
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
  /** Everything not checked-in-or-leave and not a short day:
   *  not_checked_in_yet | weekly_off | holiday | the not-short-day
   *  `absent` grades — an owner-adjudicated `absent` override or the
   *  past-no-check-in rule-9 `absent` (a rule-7 sub-half-day punch-in/out
   *  reads shortDay instead); the tile's question is "who hasn't
   *  reported an actual day". */
  notCheckedIn: number;
  /** outcome.isLate among the checkedIn rows only (the engine keeps
   *  Late null wherever there is no check-in instant, so late is a
   *  qualifier of checkedIn — not a bucket). */
  late: number;
  /** A leave grade — leave | half_day_leave (the leave credit stays a
   *  day-sheet/summary truth; the tile reads the person "on leave"). */
  onLeave: number;
  /** The ENGINE-graded short-day rows (story 20-2, live): a rule-7
   *  `absent` — punch-in AND punch-out under the half-day threshold, no
   *  owner status override. An owner-adjudicated `absent` override and
   *  the past-no-check-in rule-9 `absent` stay in notCheckedIn — the
   *  owner's word overrides the tile, always. Rows move here out of
   *  `notCheckedIn`, never copy: tracked = checkedIn + notCheckedIn +
   *  onLeave + shortDay. */
  shortDay: number;
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

/** One tracked employee's today row — the Live Team Pulse list (2026-10).
 *  `status` mirrors the tile buckets (`late` is a qualifier of checked_in,
 *  exactly like the count). `checkInAt` is the effective check-in instant
 *  (ISO) for presence rows — the punch, or a times-only override's
 *  manual check-in — and null otherwise. */
export type DashboardEmployeeStatus =
  | 'checked_in'
  | 'late'
  | 'on_leave'
  | 'short_day'
  | 'not_checked_in';

export interface DashboardEmployeeRow {
  employeeId: string;
  employeeName: string;
  /** Display form — country code + number (two people can share a name). */
  phone: string | null;
  officeName: string | null;
  status: DashboardEmployeeStatus;
  checkInAt: string | null;
  /** ISO checkout instant — present only after a check-out (or a
   *  times-only override's manual checkout). */
  checkoutAt: string | null;
  /** How far past the office's late cutoff the check-in landed (late
   *  rows only). */
  lateMinutes: number | null;
  /** The engine's worked minutes (short-day and checked-out rows). */
  workedMinutes: number | null;
  /** Which half of the day the covering approved leave takes (on-leave
   *  rows only). */
  leavePart: 'full_day' | 'first_half' | 'second_half' | null;
}

export interface DashboardResponse {
  /** The tile date — `attendance_today()`'s tenant-local YYYY-MM-DD. */
  date: string;
  counts: DashboardCounts;
  /** The office registry with today's stats — the office picker's rows. */
  offices: DashboardOfficeRow[];
  /** Today's per-employee rows — the Live Team Pulse list, sorted
   *  anomalies-first (late, on leave, short day, checked in, not checked
   *  in), name ascending within a bucket. Same office filter as the
   *  tiles. */
  employees: DashboardEmployeeRow[];
  flags: {
    checkoutMissing: CheckoutMissingFlagRow[];
    fakeLocationAttempt: FakeLocationFlagRow[];
  };
}
