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
  /** An employee submitted a leave request (17-1) — one row for the owner. */
  LEAVE_APPLIED: 'leave.applied',
  /** The owner created an approved leave on the employee's behalf (17-4). */
  LEAVE_APPLIED_ON_BEHALF: 'leave.applied_on_behalf',
  /** The owner approved the employee's leave (17-2). */
  LEAVE_APPROVED: 'leave.approved',
  /** The owner rejected the employee's leave, reason optional (17-2). */
  LEAVE_REJECTED: 'leave.rejected',
  /** The owner revoked the not-yet-started part of an approved leave (17-3). */
  LEAVE_OWNER_REVOKED: 'leave.owner_revoked',
  /** The employee cancelled the not-yet-started part of their leave (17-3). */
  LEAVE_EMPLOYEE_CANCELLED: 'leave.employee_cancelled',
  /** Disabling the employee cancelled their pending/future leave (17-1 D12). */
  LEAVE_CANCELLED_BY_DISABLE: 'leave.cancelled_by_disable',
  /** A confirmed check-in auto-cancelled today's full-day leave (17-4, FR-9). */
  LEAVE_CHECKIN_AUTO_CANCEL: 'leave.checkin_auto_cancel',
  /**
   * FR-23 (19-1): "You haven't checked in" — the tracked employee, at most
   * once per work date (pg_cron's attendance_run_reminders writes the
   * reminder arms; the dedupe rows below are database-guaranteed).
   */
  REMINDER_CHECKIN: 'attendance.reminder_checkin',
  /** "You haven't checked out" — Expected end + the actual late minutes. */
  REMINDER_CHECKOUT: 'attendance.reminder_checkout',
  /** Daily not-checked-in summary — the owner, once per office per day. */
  REMINDER_NOT_CHECKED_IN: 'attendance.reminder_not_checked_in',
  /** Pending leave exist — the owner, once per day at 10:00 tenant wall time. */
  PENDING_LEAVE_REMINDER: 'leave.pending_reminder',
} as const;

export type AttendanceNotificationEvent =
  (typeof ATTENDANCE_NOTIFICATION_EVENT)[keyof typeof ATTENDANCE_NOTIFICATION_EVENT];

/** The polymorphic deep-link kind for every attendance.* notification. */
export const ATTENDANCE_ENTITY_TYPE = 'attendance';

/** The polymorphic deep-link kind for every leave.* notification (17-1). */
export const LEAVE_ENTITY_TYPE = 'leave';

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
  [ATTENDANCE_NOTIFICATION_EVENT.LEAVE_APPLIED]: {
    eventType: ATTENDANCE_NOTIFICATION_EVENT.LEAVE_APPLIED,
    recipients:
      'The tenant owner, once per request, when an employee submits leave (FR-12).',
    payloadFields: ['employeeName', 'startDate', 'endDate', 'workingDays'],
    dedupeKeyShape: '<tenantId>:leave.applied:<recipientId>:<requestId>',
  },
  [ATTENDANCE_NOTIFICATION_EVENT.LEAVE_APPLIED_ON_BEHALF]: {
    eventType: ATTENDANCE_NOTIFICATION_EVENT.LEAVE_APPLIED_ON_BEHALF,
    recipients:
      'The employee, once per request, when the owner creates approved leave for them (FR-16).',
    payloadFields: ['startDate', 'endDate', 'workingDays'],
    dedupeKeyShape:
      '<tenantId>:leave.applied_on_behalf:<recipientId>:<requestId>',
  },
  [ATTENDANCE_NOTIFICATION_EVENT.LEAVE_APPROVED]: {
    eventType: ATTENDANCE_NOTIFICATION_EVENT.LEAVE_APPROVED,
    recipients: 'The employee, once per request, on approval (FR-13).',
    payloadFields: ['startDate', 'endDate', 'workingDays'],
    dedupeKeyShape: '<tenantId>:leave.approved:<recipientId>:<requestId>',
  },
  [ATTENDANCE_NOTIFICATION_EVENT.LEAVE_REJECTED]: {
    eventType: ATTENDANCE_NOTIFICATION_EVENT.LEAVE_REJECTED,
    recipients:
      'The employee, once per request, on rejection — reason when given (FR-13).',
    payloadFields: ['startDate', 'endDate', 'reason'],
    dedupeKeyShape: '<tenantId>:leave.rejected:<recipientId>:<requestId>',
  },
  [ATTENDANCE_NOTIFICATION_EVENT.LEAVE_OWNER_REVOKED]: {
    eventType: ATTENDANCE_NOTIFICATION_EVENT.LEAVE_OWNER_REVOKED,
    recipients:
      'The employee, once per revoke call, with the exact revoked dates and the required reason (FR-14).',
    payloadFields: ['startDate', 'endDate', 'revokedDates', 'reason'],
    dedupeKeyShape: '<tenantId>:leave.owner_revoked:<recipientId>:<requestId>',
  },
  [ATTENDANCE_NOTIFICATION_EVENT.LEAVE_EMPLOYEE_CANCELLED]: {
    eventType: ATTENDANCE_NOTIFICATION_EVENT.LEAVE_EMPLOYEE_CANCELLED,
    recipients:
      'The tenant owner, once per cancel call, with the exact cancelled dates (FR-15).',
    payloadFields: ['employeeName', 'startDate', 'endDate', 'cancelledDates'],
    dedupeKeyShape:
      '<tenantId>:leave.employee_cancelled:<recipientId>:<requestId>',
  },
  [ATTENDANCE_NOTIFICATION_EVENT.LEAVE_CANCELLED_BY_DISABLE]: {
    eventType: ATTENDANCE_NOTIFICATION_EVENT.LEAVE_CANCELLED_BY_DISABLE,
    recipients:
      'The employee, once per affected request, when disabling them cancels pending/future leave (AD-23 disable).',
    payloadFields: ['startDate', 'endDate', 'cancelledDates'],
    dedupeKeyShape:
      '<tenantId>:leave.cancelled_by_disable:<recipientId>:<requestId>',
  },
  [ATTENDANCE_NOTIFICATION_EVENT.LEAVE_CHECKIN_AUTO_CANCEL]: {
    eventType: ATTENDANCE_NOTIFICATION_EVENT.LEAVE_CHECKIN_AUTO_CANCEL,
    recipients:
      'The tenant owner, once per cancelled leave date, when a confirmed check-in auto-cancels that day (FR-9).',
    payloadFields: ['employeeName', 'leaveDate'],
    dedupeKeyShape:
      '<tenantId>:leave.checkin_auto_cancel:<recipientId>:<requestId>:<leaveDate>',
  },
  [ATTENDANCE_NOTIFICATION_EVENT.REMINDER_CHECKIN]: {
    eventType: ATTENDANCE_NOTIFICATION_EVENT.REMINDER_CHECKIN,
    // NFR-10 wave 1 (time-sensitive): tracked employee, working day, no
    // check-in, no approved full-day leave; due at Start + Late cut-off
    // (Midpoint + cut-off on an approved first-half leave day). Written by
    // attendance_run_reminders() — never by an API request path.
    recipients:
      'A tracked employee, at most once per work_date (FR-23); never on weekly offs, holidays, an approved full-day leave, the enable-day grace or a status-only day override.',
    payloadFields: ['workDate'],
    dedupeKeyShape:
      '<tenantId>:attendance.reminder_checkin:<recipientId>:<workDate>',
  },
  [ATTENDANCE_NOTIFICATION_EVENT.REMINDER_CHECKOUT]: {
    eventType: ATTENDANCE_NOTIFICATION_EVENT.REMINDER_CHECKOUT,
    // NFR-10 wave 1. Due at Expected end + actual late minutes (late = 0 →
    // Expected end, user decision 2026-09-29); Midpoint + late minutes on
    // an approved second-half leave day.
    recipients:
      'A tracked employee with a check-in and no check-out by the due instant, at most once per work_date.',
    payloadFields: ['workDate', 'checkinAt'],
    dedupeKeyShape:
      '<tenantId>:attendance.reminder_checkout:<recipientId>:<workDate>',
  },
  [ATTENDANCE_NOTIFICATION_EVENT.REMINDER_NOT_CHECKED_IN]: {
    eventType: ATTENDANCE_NOTIFICATION_EVENT.REMINDER_NOT_CHECKED_IN,
    // NFR-10 wave 2 (informational): the owner, keyed per office so two
    // offices summarise independently on the same day.
    recipients:
      'The tenant owner, once per office per day at that office’s Start + Late cut-off, when the office has tracked employees with no check-in and no approved full-day leave.',
    payloadFields: ['officeName', 'notCheckedInCount', 'workDate'],
    dedupeKeyShape:
      '<tenantId>:attendance.reminder_not_checked_in:<recipientId>:<workDate>:<officeId>',
  },
  [ATTENDANCE_NOTIFICATION_EVENT.PENDING_LEAVE_REMINDER]: {
    eventType: ATTENDANCE_NOTIFICATION_EVENT.PENDING_LEAVE_REMINDER,
    // NFR-10 wave 2. A request arriving after 10:00 stays silent until
    // tomorrow (FR-23's "once a day"): the key embeds the work date only.
    recipients:
      'The tenant owner, once per day at 10:00 tenant wall time, when any pending leave day exists for the tenant.',
    payloadFields: ['pendingCount'],
    dedupeKeyShape:
      '<tenantId>:leave.pending_reminder:<recipientId>:<workDate>',
  },
};

/** Every registered event type (handy for FE-mirror diff tests). */
export const ATTENDANCE_NOTIFICATION_EVENT_TYPES: AttendanceNotificationEvent[] =
  Object.values(ATTENDANCE_NOTIFICATION_EVENT);
