/**
 * The day-status engine's status/marker vocabulary (extracted 21-1 from
 * the attendance wire model so the engine and every consumer — the
 * attendance routes, Epic 19 aggregates and the reports fetcher — share
 * ONE key set; NFR5 keeps reports importing only common/).
 *
 * The 12 keys of UX-DR1; the FE Badge vocabulary (18-3) is generated from
 * that array's documentation, never re-enumerated anywhere.
 */

const STATUS_KEYS = [
  'not_tracked',
  'not_checked_in_yet',
  'in_progress',
  'weekly_off',
  'holiday',
  'worked_on_holiday',
  'leave',
  'half_day_leave',
  'present',
  'half_day',
  'absent',
  'checkout_missing',
] as const;

const MARKER_KEYS = [
  'corrected',
  'leave_pending',
  'checkout_missing',
  'fake_location_attempt',
] as const;

export type DayStatusKey = (typeof STATUS_KEYS)[number];
export type DayMarkerKey = (typeof MARKER_KEYS)[number];
export type AttendanceSource = 'gps' | 'manual' | null;

export const STATUS_KEYS_READONLY: readonly DayStatusKey[] = STATUS_KEYS;
export const MARKER_KEYS_READONLY: readonly DayMarkerKey[] = MARKER_KEYS;
