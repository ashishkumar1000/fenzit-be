import {
  ATTENDANCE_ENTITY_TYPE,
  ATTENDANCE_NOTIFICATION_EVENT,
  ATTENDANCE_NOTIFICATION_EVENT_REGISTRY,
  ATTENDANCE_NOTIFICATION_EVENT_TYPES,
  LEAVE_ENTITY_TYPE,
} from './notification-events';

/**
 * The AD-13 registry is the backend source of truth the RPCs (20260927000002)
 * and the NestJS emitters (16-1's fake-location alert, Epic 17's leave
 * lifecycle via leave-transition.ts) write against, and 15-6/17-x's FE
 * mirrors. These pins hold the sides together: the event strings, the
 * payload keys and the recipient-prefixed dedupe-key shape — a drift in
 * any one breaks the 14.2 partial unique index contract or the FE rendering.
 */
describe('notification-events registry (AD-13, stories 15-5 + 16-1 + 17-1..4)', () => {
  it('pins the event type strings exactly as the writers emit them', () => {
    expect(ATTENDANCE_NOTIFICATION_EVENT.HOLIDAY_ADDED).toBe(
      'attendance.holiday_added',
    );
    expect(ATTENDANCE_NOTIFICATION_EVENT.HOLIDAY_REMOVED).toBe(
      'attendance.holiday_removed',
    );
    expect(ATTENDANCE_NOTIFICATION_EVENT.FAKE_LOCATION).toBe(
      'attendance.fake_location',
    );
    expect(ATTENDANCE_NOTIFICATION_EVENT.LEAVE_APPLIED).toBe('leave.applied');
    expect(ATTENDANCE_NOTIFICATION_EVENT.LEAVE_APPLIED_ON_BEHALF).toBe(
      'leave.applied_on_behalf',
    );
    expect(ATTENDANCE_NOTIFICATION_EVENT.LEAVE_APPROVED).toBe('leave.approved');
    expect(ATTENDANCE_NOTIFICATION_EVENT.LEAVE_REJECTED).toBe('leave.rejected');
    expect(ATTENDANCE_NOTIFICATION_EVENT.LEAVE_OWNER_REVOKED).toBe(
      'leave.owner_revoked',
    );
    expect(ATTENDANCE_NOTIFICATION_EVENT.LEAVE_EMPLOYEE_CANCELLED).toBe(
      'leave.employee_cancelled',
    );
    expect(ATTENDANCE_NOTIFICATION_EVENT.LEAVE_CANCELLED_BY_DISABLE).toBe(
      'leave.cancelled_by_disable',
    );
    expect(ATTENDANCE_NOTIFICATION_EVENT.LEAVE_CHECKIN_AUTO_CANCEL).toBe(
      'leave.checkin_auto_cancel',
    );
  });

  it('names every event attendance.<snake_case> or leave.<snake_case> (AD-13 naming)', () => {
    for (const eventType of ATTENDANCE_NOTIFICATION_EVENT_TYPES) {
      expect(eventType).toMatch(/^(attendance|leave)\.[a-z_]+$/);
    }
  });

  it('registers exactly one metadata entry per event type', () => {
    expect(Object.keys(ATTENDANCE_NOTIFICATION_EVENT_REGISTRY).sort()).toEqual([
      'attendance.fake_location',
      'attendance.holiday_added',
      'attendance.holiday_removed',
      'leave.applied',
      'leave.applied_on_behalf',
      'leave.approved',
      'leave.cancelled_by_disable',
      'leave.checkin_auto_cancel',
      'leave.employee_cancelled',
      'leave.owner_revoked',
      'leave.rejected',
    ]);
    for (const [eventType, meta] of Object.entries(
      ATTENDANCE_NOTIFICATION_EVENT_REGISTRY,
    )) {
      expect(meta.eventType).toBe(eventType);
    }
  });

  it('carries the self-contained camelCase payload each writer builds', () => {
    // jsonb_build_object('holidayName', …, 'holidayDate', …) in
    // attendance_add_holiday / attendance_remove_holiday.
    expect(
      ATTENDANCE_NOTIFICATION_EVENT_REGISTRY[
        ATTENDANCE_NOTIFICATION_EVENT.HOLIDAY_ADDED
      ].payloadFields,
    ).toEqual(['holidayName', 'holidayDate']);
    expect(
      ATTENDANCE_NOTIFICATION_EVENT_REGISTRY[
        ATTENDANCE_NOTIFICATION_EVENT.HOLIDAY_REMOVED
      ].payloadFields,
    ).toEqual(['holidayName', 'holidayDate']);
    // The NestJS emitter in check-in-out.service.ts (16-1).
    expect(
      ATTENDANCE_NOTIFICATION_EVENT_REGISTRY[
        ATTENDANCE_NOTIFICATION_EVENT.FAKE_LOCATION
      ].payloadFields,
    ).toEqual(['employeeName', 'month', 'attemptCount']);
    // The leave-transition.ts emitters (17-1..17-4, spec D14).
    expect(
      ATTENDANCE_NOTIFICATION_EVENT_REGISTRY[
        ATTENDANCE_NOTIFICATION_EVENT.LEAVE_APPLIED
      ].payloadFields,
    ).toEqual(['employeeName', 'startDate', 'endDate', 'workingDays']);
    expect(
      ATTENDANCE_NOTIFICATION_EVENT_REGISTRY[
        ATTENDANCE_NOTIFICATION_EVENT.LEAVE_APPLIED_ON_BEHALF
      ].payloadFields,
    ).toEqual(['startDate', 'endDate', 'workingDays']);
    expect(
      ATTENDANCE_NOTIFICATION_EVENT_REGISTRY[
        ATTENDANCE_NOTIFICATION_EVENT.LEAVE_APPROVED
      ].payloadFields,
    ).toEqual(['startDate', 'endDate', 'workingDays']);
    expect(
      ATTENDANCE_NOTIFICATION_EVENT_REGISTRY[
        ATTENDANCE_NOTIFICATION_EVENT.LEAVE_REJECTED
      ].payloadFields,
    ).toEqual(['startDate', 'endDate', 'reason']);
    expect(
      ATTENDANCE_NOTIFICATION_EVENT_REGISTRY[
        ATTENDANCE_NOTIFICATION_EVENT.LEAVE_OWNER_REVOKED
      ].payloadFields,
    ).toEqual(['startDate', 'endDate', 'revokedDates', 'reason']);
    expect(
      ATTENDANCE_NOTIFICATION_EVENT_REGISTRY[
        ATTENDANCE_NOTIFICATION_EVENT.LEAVE_EMPLOYEE_CANCELLED
      ].payloadFields,
    ).toEqual(['employeeName', 'startDate', 'endDate', 'cancelledDates']);
    expect(
      ATTENDANCE_NOTIFICATION_EVENT_REGISTRY[
        ATTENDANCE_NOTIFICATION_EVENT.LEAVE_CANCELLED_BY_DISABLE
      ].payloadFields,
    ).toEqual(['startDate', 'endDate', 'cancelledDates']);
    expect(
      ATTENDANCE_NOTIFICATION_EVENT_REGISTRY[
        ATTENDANCE_NOTIFICATION_EVENT.LEAVE_CHECKIN_AUTO_CANCEL
      ].payloadFields,
    ).toEqual(['employeeName', 'leaveDate']);
  });

  it('embeds the recipient in every dedupe key — the global partial unique index is on dedupe_key alone', () => {
    expect(
      ATTENDANCE_NOTIFICATION_EVENT_REGISTRY[
        ATTENDANCE_NOTIFICATION_EVENT.HOLIDAY_ADDED
      ].dedupeKeyShape,
    ).toBe('<tenantId>:attendance.holiday_added:<recipientId>:<holidayId>');
    expect(
      ATTENDANCE_NOTIFICATION_EVENT_REGISTRY[
        ATTENDANCE_NOTIFICATION_EVENT.HOLIDAY_REMOVED
      ].dedupeKeyShape,
    ).toBe('<tenantId>:attendance.holiday_removed:<recipientId>:<holidayId>');
    expect(
      ATTENDANCE_NOTIFICATION_EVENT_REGISTRY[
        ATTENDANCE_NOTIFICATION_EVENT.FAKE_LOCATION
      ].dedupeKeyShape,
    ).toBe(
      '<tenantId>:attendance.fake_location:<recipientId>:<employeeId>:<yyyy-mm>',
    );
    for (const meta of Object.values(ATTENDANCE_NOTIFICATION_EVENT_REGISTRY)) {
      // 14-2 convention: the key starts with the tenant and carries the
      // recipient — a multi-recipient fan-out can never collide.
      expect(meta.dedupeKeyShape.startsWith('<tenantId>:')).toBe(true);
      expect(meta.dedupeKeyShape).toContain('<recipientId>');
    }
  });

  it('states a recipient rule for every event (prose the writer predicate implements)', () => {
    for (const meta of Object.values(ATTENDANCE_NOTIFICATION_EVENT_REGISTRY)) {
      expect(meta.recipients.length).toBeGreaterThan(0);
    }
    // Future-dates-only is the scope decision both holiday events share.
    expect(
      ATTENDANCE_NOTIFICATION_EVENT_REGISTRY[
        ATTENDANCE_NOTIFICATION_EVENT.HOLIDAY_ADDED
      ].recipients,
    ).toContain('Future dates');
  });

  it('uses the attendance and leave entity types for the polymorphic deep link', () => {
    expect(ATTENDANCE_ENTITY_TYPE).toBe('attendance');
    expect(LEAVE_ENTITY_TYPE).toBe('leave');
  });

  it('lists every registered type in a stable, duplicate-free array', () => {
    expect(ATTENDANCE_NOTIFICATION_EVENT_TYPES).toEqual([
      'attendance.holiday_added',
      'attendance.holiday_removed',
      'attendance.fake_location',
      'leave.applied',
      'leave.applied_on_behalf',
      'leave.approved',
      'leave.rejected',
      'leave.owner_revoked',
      'leave.employee_cancelled',
      'leave.cancelled_by_disable',
      'leave.checkin_auto_cancel',
    ]);
    expect(new Set(ATTENDANCE_NOTIFICATION_EVENT_TYPES).size).toBe(
      ATTENDANCE_NOTIFICATION_EVENT_TYPES.length,
    );
  });
});
