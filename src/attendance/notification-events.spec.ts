import {
  ATTENDANCE_ENTITY_TYPE,
  ATTENDANCE_NOTIFICATION_EVENT,
  ATTENDANCE_NOTIFICATION_EVENT_REGISTRY,
  ATTENDANCE_NOTIFICATION_EVENT_TYPES,
} from './notification-events';

/**
 * The AD-13 registry is the backend source of truth the RPCs (20260927000002)
 * and the NestJS emitters (16-1's fake-location alert) write against, and
 * 15-6's FE mirrors. These pins hold the sides together: the event strings,
 * the payload keys and the recipient-prefixed dedupe-key shape — a drift in
 * any one breaks the 14.2 partial unique index contract or the FE rendering.
 */
describe('notification-events registry (AD-13, stories 15-5 + 16-1)', () => {
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
  });

  it('names every event attendance.<snake_case> (AD-13 naming)', () => {
    for (const eventType of ATTENDANCE_NOTIFICATION_EVENT_TYPES) {
      expect(eventType).toMatch(/^attendance\.[a-z_]+$/);
    }
  });

  it('registers exactly one metadata entry per event type', () => {
    expect(Object.keys(ATTENDANCE_NOTIFICATION_EVENT_REGISTRY).sort()).toEqual([
      'attendance.fake_location',
      'attendance.holiday_added',
      'attendance.holiday_removed',
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

  it('uses the attendance entity type for the polymorphic deep link', () => {
    expect(ATTENDANCE_ENTITY_TYPE).toBe('attendance');
  });

  it('lists every registered type in a stable, duplicate-free array', () => {
    expect(ATTENDANCE_NOTIFICATION_EVENT_TYPES).toEqual([
      'attendance.holiday_added',
      'attendance.holiday_removed',
      'attendance.fake_location',
    ]);
    expect(new Set(ATTENDANCE_NOTIFICATION_EVENT_TYPES).size).toBe(
      ATTENDANCE_NOTIFICATION_EVENT_TYPES.length,
    );
  });
});
