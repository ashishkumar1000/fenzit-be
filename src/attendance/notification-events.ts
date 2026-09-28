/**
 * AD-13: the backend registry of every attendance/leave notification event
 * — the single source of truth for event type strings, recipient rules,
 * payload contracts and dedupe-key shapes. The FE mirrors this list in
 * 15-6; every later attendance/leave emitter (16 fake-location, 17 leave
 * lifecycle, 19 reminders) extends this registry instead of inventing a
 * per-story contract.
 *
 * The DB functions in 20260927000002 are the writers; if an event here
 * changes, the RPC and this registry change in the same commit.
 */

/** Event type strings exactly as the RPCs write them to notifications. */
export const ATTENDANCE_NOTIFICATION_EVENT = {
  /** A future-dated holiday was added — one row per tracked employee. */
  HOLIDAY_ADDED: 'attendance.holiday_added',
  /** A future-dated holiday was removed — one row per tracked employee. */
  HOLIDAY_REMOVED: 'attendance.holiday_removed',
  /**
   * An employee's 3rd `mocked` check-in/out attempt this calendar month —
   * one row per owner per employee per month, deduped by key (16-1).
   */
  FAKE_LOCATION: 'attendance.fake_location',
} as const;

export type AttendanceNotificationEvent =
  (typeof ATTENDANCE_NOTIFICATION_EVENT)[keyof typeof ATTENDANCE_NOTIFICATION_EVENT];

/** The polymorphic deep-link kind for every attendance.* notification. */
export const ATTENDANCE_ENTITY_TYPE = 'attendance';

/**
 * Registry entry metadata. `payloadFields` is the self-contained camelCase
 * payload the FE renders from — the row must survive without its entity.
 */
export interface AttendanceNotificationEventMeta {
  /** The notifications.event_type string. */
  eventType: AttendanceNotificationEvent;
  /** Who receives it (prose — the recipient predicate lives in the RPC). */
  recipients: string;
  /** camelCase payload keys, in payload order. */
  payloadFields: string[];
  /**
   * Dedupe-key shape (the 14-2 recipient-prefixed convention — the partial
   * unique index is global on dedupe_key alone, so the recipient MUST be
   * embedded or a multi-recipient fan-out collides).
   */
  dedupeKeyShape: string;
}

export const ATTENDANCE_NOTIFICATION_EVENT_REGISTRY: Record<
  AttendanceNotificationEvent,
  AttendanceNotificationEventMeta
> = {
  [ATTENDANCE_NOTIFICATION_EVENT.HOLIDAY_ADDED]: {
    eventType: ATTENDANCE_NOTIFICATION_EVENT.HOLIDAY_ADDED,
    recipients:
      'Employees tracked (enrolled, enrolment covering the holiday date) on the day the holiday is added; setup must be completed. Future dates only.',
    payloadFields: ['holidayName', 'holidayDate'],
    dedupeKeyShape:
      '<tenantId>:attendance.holiday_added:<recipientId>:<holidayId>',
  },
  [ATTENDANCE_NOTIFICATION_EVENT.HOLIDAY_REMOVED]: {
    eventType: ATTENDANCE_NOTIFICATION_EVENT.HOLIDAY_REMOVED,
    recipients:
      'Employees tracked on the removed holiday date; future dates only (past removals are silent — statuses recompute on read).',
    payloadFields: ['holidayName', 'holidayDate'],
    dedupeKeyShape:
      '<tenantId>:attendance.holiday_removed:<recipientId>:<holidayId>',
  },
  [ATTENDANCE_NOTIFICATION_EVENT.FAKE_LOCATION]: {
    eventType: ATTENDANCE_NOTIFICATION_EVENT.FAKE_LOCATION,
    recipients:
      'The tenant owner, exactly once per employee per calendar month, on the 3rd counted mocked attempt (AD-13/FR-7).',
    payloadFields: ['employeeName', 'month', 'attemptCount'],
    dedupeKeyShape:
      '<tenantId>:attendance.fake_location:<recipientId>:<employeeId>:<yyyy-mm>',
  },
};

/** Every registered event type (handy for FE-mirror diff tests). */
export const ATTENDANCE_NOTIFICATION_EVENT_TYPES: AttendanceNotificationEvent[] =
  Object.values(ATTENDANCE_NOTIFICATION_EVENT);
