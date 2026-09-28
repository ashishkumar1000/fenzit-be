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

/** The Nth counted rejection inside the window that trips the block (AD-15). */
export const RATE_MAX_COUNTED = 5;

/** How long the block lasts, measured from the tripping attempt (AD-15). */
export const RATE_BLOCK_MINUTES = 10;

/** Outcomes that count toward the rate-limit budget (AD-15). */
export const COUNTED_OUTCOMES = [
  'too_far',
  'low_accuracy',
  'mocked',
  'stale_fix',
] as const;

export type CountedOutcome = (typeof COUNTED_OUTCOMES)[number];

/** Every outcome the attempts CHECK constraint admits (migration 20260928000002).
 * `leave_confirmation_required` has no writer until Epic 17 (spec D14) but is
 * admitted now so Epic 17's first writer cannot 23514 (review finding). */
export const ATTEMPT_OUTCOMES = [
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
