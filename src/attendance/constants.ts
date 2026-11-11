/**
 * Check-in/out thresholds and budgets (16-1/16-2). The PRD delegated the
 * rate-limit values to implementation ("Values decided by Claude on
 * delegation"); they live here as the single tunable place — the accuracy
 * and fix-age caps come straight from FR-5/FR-7/AD-20.
 */

/** GPS accuracy worse than this rejects with `low_accuracy` (FR-7). */
export const CHECKIN_MAX_ACCURACY_M = 100;

/** A fix older than this rejects with `stale_fix` (AD-20, defence in depth). */
export const FIX_MAX_AGE_MS = 30_000;

/** Rate-limit window: counted rejections older than this fall out (AD-15). */
export const RATE_WINDOW_MINUTES = 10;

/** The Nth counted rejection inside the window that trips the block (AD-15).
 *  5 → 70 (owner decision 2026-11-10): with `too_far` decounted, the counted
 *  outcomes are all abuse-shaped (spoofed accuracy, mocks, replayed fixes),
 *  and 70 makes an accidental lockout of a fumbling employee unreachable —
 *  the block only lands on sustained deliberate abuse. */
export const RATE_MAX_COUNTED = 70;

/** How long the block lasts, measured from the tripping attempt (AD-15). */
export const RATE_BLOCK_MINUTES = 10;

/** Outcomes that count toward the rate-limit budget (AD-15). `too_far` is
 *  deliberately excluded (owner decision 2026-11-10): a legitimate employee
 *  walking closer to the office and retrying is normal behaviour, and the
 *  client no longer pre-blocks the punch, so blocking on it bought nothing
 *  but false lockouts. The remaining outcomes skew abuse-shaped (mock
 *  locations, replayed stale fixes) — but `low_accuracy` can also come from
 *  a legitimate bad-GPS spot, and with the client lock gone every bad-fix
 *  press reaches the server and feeds the counter; the 70 budget exists
 *  exactly so those honest streaks never lock anyone out. */
export const COUNTED_OUTCOMES = [
  'low_accuracy',
  'mocked',
  'stale_fix',
] as const;

export type CountedOutcome = (typeof COUNTED_OUTCOMES)[number];

/** Every outcome the attempts CHECK constraint admits (migration 20260928000002).
 * `too_far` is written on every distance rejection but is DECOUNTED from the
 * rate budget (owner decision 2026-11-10) — it lives here, not in
 * COUNTED_OUTCOMES. `leave_confirmation_required` is written by the check-in
 * transaction's leave-confirmation path since 17-4 (spec D11) — the attempt
 * row makes the auto-cancel auditable like every other outcome. */
export const ATTEMPT_OUTCOMES = [
  'too_far',
  ...COUNTED_OUTCOMES,
  'ok',
  'rate_limited',
  'not_tracked',
  'already_checked_in',
  'already_checked_out',
  'not_checked_in',
  'leave_confirmation_required',
] as const;

export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

/** The 3rd `mocked` attempt in a calendar month alerts the owner (AD-13). */
export const FAKE_LOCATION_ALERT_THRESHOLD = 3;
