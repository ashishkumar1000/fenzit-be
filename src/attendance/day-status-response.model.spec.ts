import { toDayStatusRow } from './day-status-response.model';
import { computeDayStatus } from './day-status.model';
import type { LatestCorrectionView } from './correction.model';

/**
 * Pure spec for the day-status wire mapper (18-1). Written as a tester: the
 * mapper never re-derives a grade (AD-22 — it only shapes what the engine
 * returned) and the instants travel as AD-7 tenant-offset ISO. A change to
 * the implementation (not the requirement) must not turn these red.
 */

const TZ = 'Asia/Kolkata';
const OUTCOME = computeDayStatus({
  ctx: {
    tenantId: 't', employeeId: 'e', workDate: '2026-09-28', timezone: TZ,
    trackedBase: true, tracked: true, enableDayGraceBlocks: false,
    officeId: 'o1', officeName: 'HQ', officeLat: 0, officeLng: 0, radiusM: 100,
    officeRulesId: 'r1', startMinute: 570, endMinute: 1110, midpointMinute: 840,
    lateCutoffMinutes: 15, fullDayMinutes: 480, halfDayMinutes: 240,
    isWeeklyOff: false, holidayId: null, holidayName: null,
    isWorkingDay: true, leaveState: null, leavePart: null,
  },
  record: {
    // 09:50 and 18:40 in tenant wall time (late by 5, worked 530).
    checkin_at: new Date('2026-09-28T09:50:00+05:30'),
    checkout_at: new Date('2026-09-28T18:40:00+05:30'),
  },
  override: null,
  hasUnackMockedAttempt: false,
  today: '2026-10-01',
});

const latest: LatestCorrectionView = {
  correctedAt: '2026-09-28T10:00:00.000Z',
  actorName: 'Owner',
  note: 'Fixed check-in',
  oldValue: { status: 'absent', checkinAt: null, checkoutAt: null },
  newValue: { status: 'present', checkinAt: null, checkoutAt: null },
};

const row = (over: Partial<Parameters<typeof toDayStatusRow>[0]> = {}) =>
  toDayStatusRow({
    workDate: '2026-09-28',
    isWeeklyOff: false,
    holidayName: null,
    isWorkingDay: true,
    officeId: 'o1',
    officeName: 'HQ',
    timezone: TZ,
    outcome: OUTCOME,
    checkin: new Date('2026-09-28T09:50:00+05:30'),
    checkout: new Date('2026-09-28T18:40:00+05:30'),
    latestCorrection: null,
    ...over,
  });

describe('toDayStatusRow — the engine outcome is echoed, never re-derived', () => {
  it('carries every metric straight from the outcome (present/1.0 case)', () => {
    const r = row();
    expect(r.status).toBe(OUTCOME.status);
    expect(r.daysWorked).toBe(OUTCOME.daysWorked);
    expect(r.leaveCredit).toBe(OUTCOME.leaveCredit);
    expect(r.workedOnHolidayCredit).toBe(OUTCOME.workedOnHolidayCredit);
    expect(r.workedMinutes).toBe(OUTCOME.workedMinutes);
    expect(r.lateMinutes).toBe(5);
    expect(r.isLate).toBe(true);
  });

  it('the ctx labels ride the row, not the outcome', () => {
    const r = row({ isWeeklyOff: true, holidayName: 'Diwali', isWorkingDay: false });
    expect(r.isWeeklyOff).toBe(true);
    expect(r.holidayName).toBe('Diwali');
    expect(r.isWorkingDay).toBe(false);
    expect(r.status).toBe(OUTCOME.status); // 530 worked ≥ the 8h setting: present, untouched by the labels
  });
});

describe('toDayStatusRow — the instants as AD-7 tenant-offset ISO', () => {
  it('instantiates the tenant-offset spelling (never a Z/UTC instant)', () => {
    const r = row();
    expect(r.checkinAt).toBe('2026-09-28T09:50:00+05:30');
    expect(r.checkoutAt).toBe('2026-09-28T18:40:00+05:30');
  });

  it('a null instant stays null, and the sources come from the outcome', () => {
    const outcome = { ...OUTCOME, checkinSource: null as never, checkoutSource: 'gps' as never };
    const r = row({ outcome, checkin: null });
    expect(r.checkinAt).toBeNull();
    expect(r.checkoutAt).toBe('2026-09-28T18:40:00+05:30');
    expect(r.checkinSource).toBeNull();
    expect(r.checkoutSource).toBe('gps');
  });

  it('a manual (times-corrected) instant keeps its source on the wire row', () => {
    const outcome = { ...OUTCOME, checkinSource: 'manual' as never };
    const r = row({ outcome, checkin: new Date('2026-09-28T10:00:00+05:30') });
    expect(r.checkinSource).toBe('manual');
    expect(r.checkinAt).toBe('2026-09-28T10:00:00+05:30');
  });
});

describe('toDayStatusRow — markers and the latest-correction one-liner', () => {
  it('markers are a defensive COPY — mutating the row must not touch the outcome', () => {
    const r = row();
    (r.markers as string[]).push('corrected');
    expect(OUTCOME.markers).not.toContain('corrected');
  });

  it('latestCorrection is ABSENT from the JSON when the day has no audit history', () => {
    const r = row();
    expect('latestCorrection' in r).toBe(false);
    expect(r.latestCorrection).toBeUndefined();
  });

  it('latestCorrection is PRESENT (the sheet pre-fill source) when history exists', () => {
    const r = row({ latestCorrection: latest });
    expect(r.latestCorrection).toEqual(latest);
  });
});
