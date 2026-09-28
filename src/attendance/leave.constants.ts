import type { CountedOutcome } from './constants';

/**
 * Leave lifecycle thresholds and vocabularies (17-1..17-4). The PRD fixes
 * the 7-day back-date limit and the 500-char reason; the span cap is an
 * implementation DoS bound (spec D15) — one constant to re-tune.
 */

/** PRD FR-12: leave may be requested at most this many days in the past. */
export const LEAVE_MAX_PAST_DAYS = 7;

/** Implementation DoS cap (spec D15) — an unbounded range inserts unbounded day rows. */
export const LEAVE_MAX_SPAN_DAYS = 62;

/** PRD FR-12: reason is required, free text, max 500 characters. */
export const LEAVE_REASON_MAX = 500;

export const LEAVE_PARTS = ['full_day', 'first_half', 'second_half'] as const;
export type LeavePart = (typeof LEAVE_PARTS)[number];

export const LEAVE_DAY_STATES = [
  'pending',
  'approved',
  'rejected',
  'cancelled',
  'revoked',
] as const;
export type LeaveDayState = (typeof LEAVE_DAY_STATES)[number];

/**
 * AD-23's causes — the closed vocabulary of `leave_events.cause` and the
 * transition writer's notification dispatch.
 */
export const LEAVE_CAUSES = [
  'apply',
  'apply_on_behalf',
  'approve',
  'reject',
  'employee_cancel',
  'owner_revoke',
  'checkin_auto_cancel',
  'disable',
  'removal',
] as const;
export type LeaveCause = (typeof LEAVE_CAUSES)[number];

/**
 * D5: the derived request status order — THE single source. The model
 * derives from it and the repository's SQL CASE is generated from it, so
 * `?status=` can never disagree with the displayed status.
 */
export const DERIVED_STATUS_ORDER = [
  'pending',
  'approved',
  'revoked',
  'cancelled',
  'rejected',
] as const;
export type DerivedLeaveStatus = (typeof DERIVED_STATUS_ORDER)[number];

/** States that make a day "active" for the overlap rule (the partial unique index). */
export const ACTIVE_LEAVE_STATES: LeaveDayState[] = ['pending', 'approved'];

/** The day states approve/reject acts on (a mixed request keeps cancelled days). */
export const PENDING_SOURCE_STATES: LeaveDayState[] = ['pending'];

/** Revoke acts on approved days only; cancel takes pending AND approved (FR-15). */
export const REVOKE_SOURCE_STATES: LeaveDayState[] = ['approved'];
export const CANCEL_SOURCE_STATES: LeaveDayState[] = ['pending', 'approved'];

/** PG constraint names the repository maps to outcomes (spec D7). */
export const PG_OVERLAP_CONSTRAINT = 'leave_request_days_active_uq';
export const PG_REQUEST_KEY_CONSTRAINT = 'leave_requests_tenant_request_uq';

/** The PT-style SQLSTATE the guard trigger raises (house vocabulary). */
export const PG_LEAVE_TRANSITION_CODE = 'PT422';

/**
 * The attempts outcome (16-1's CHECK already admits it). It is deliberately
 * NOT in COUNTED_OUTCOMES — AD-15's counted list is closed (spec D11).
 */
export const LEAVE_CONFIRMATION_OUTCOME = 'leave_confirmation_required';
export type LeaveConfirmationOutcome = typeof LEAVE_CONFIRMATION_OUTCOME;

/** Guard so a renamed counted-outcome list cannot silently include the gate. */
const _neverCounted: Exclude<LeaveConfirmationOutcome, CountedOutcome> =
  'leave_confirmation_required';
void _neverCounted;
