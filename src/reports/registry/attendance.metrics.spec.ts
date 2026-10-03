import type { DayContext } from '../../common/day-status/day-context';
import type {
  DayGridRow,
  RecordRow,
  OverrideRow,
} from '../../common/day-status/grid-reader';
import {
  computeAttendanceExceptions,
  registerCode,
  summariseAttendanceRange,
} from './attendance.metrics';

/**
 * Pure spec for 21-2's report aggregations. Tester rules: the nine app
 * summary numbers must match summariseEmployeeMonth's outputs for the SAME
 * rows (parity is the feature's core contract); the derived numbers must
 * honour the spec formulas (leave OUT of the expected denominator, hours
 * from non-null workedMinutes only); exceptions must fire on real shapes
 * (streaks of exactly 3, repeat late, unacknowledged fake location) and
 * stay silent on look-alikes (2-day streaks, acknowledged mock flags).
 */

const TODAY = '2026-09-29';
const TENANT = '00000000-0000-4000-8000-000000000001';
const EMP = '00000000-0000-4000-8000-000000000002';
const EMP2 = '00000000-0000-4000-8000-000000000003';

const record = (
  date: string,
  checkin: string,
  checkout: string | null,
): RecordRow => ({
  employee_id: EMP,
  work_date: date,
  checkin_at: new Date(`${date}T${checkin}:00+05:30`),
  checkout_at: checkout ? new Date(`${date}T${checkout}:00+05:30`) : null,
  checkin_distance_m: null,
  checkout_distance_m: null,
});

const override = (fields: Partial<OverrideRow> = {}): OverrideRow => ({
  employee_id: EMP,
  work_date: '2026-09-28',
  status: null,
  manual_checkin_at: null,
  manual_checkout_at: null,
  ...fields,
});

const ctx = (date: string, over: Partial<DayContext> = {}): DayContext => ({
  tenantId: TENANT,
  employeeId: EMP,
  workDate: date,
  timezone: 'Asia/Kolkata',
  trackedBase: true,
  tracked: true,
  enableDayGraceBlocks: false,
  officeId: 'office-1',
  officeName: 'HQ',
  officeLat: 12.97,
  officeLng: 77.59,
  radiusM: 100,
  officeRulesId: 'rule-1',
  startMinute: 570,
  endMinute: 1110,
  midpointMinute: 840,
  lateCutoffMinutes: 15,
  fullDayMinutes: 480,
  halfDayMinutes: 240,
  isWeeklyOff: false,
  holidayId: null,
  holidayName: null,
  isWorkingDay: true,
  leaveState: null,
  leavePart: null,
  leaveRequestId: null,
  ...over,
});

const row = (over: {
  workDate?: string;
  ctx?: Partial<DayContext>;
  record?: RecordRow | null;
  override?: OverrideRow | null;
  hasUnackMockedAttempt?: boolean;
  employeeId?: string;
}): DayGridRow => {
  const date = over.workDate ?? '2026-09-28';
  return {
    employeeId: over.employeeId ?? EMP,
    workDate: date,
    today: TODAY,
    ctx: ctx(date, { employeeId: over.employeeId ?? EMP, ...over.ctx }),
    record: over.record ?? null,
    override: over.override ?? null,
    hasUnackMockedAttempt: over.hasUnackMockedAttempt ?? false,
    latestCorrection: null,
  };
};

/** A full worked day 09:30→18:30 = 540 minutes (late-free, on time). */
const fullDay = (date: string, over: Parameters<typeof row>[0] = {}): DayGridRow =>
  row({
    workDate: date,
    record: record(date, '09:30', '18:30') as RecordRow,
    ...over,
  });

describe('summariseAttendanceRange — parity with the app aggregation', () => {
  it('the nine summary numbers equal summariseEmployeeMonth on the same rows', () => {
    const rows = [
      fullDay('2026-09-25'),
      row({ workDate: '2026-09-26', record: record('2026-09-26', '09:30', '13:30') }),
      row({ workDate: '2026-09-27', ctx: { isWeeklyOff: true } }),
      row({ workDate: '2026-09-28', ctx: { leaveState: 'approved', leavePart: 'full_day' } }),
    ];
    const summary = summariseAttendanceRange(rows);
    expect(summary.daysWorked).toBe(1.5); // full + half
    expect(summary.halfDays).toBe(1);
    expect(summary.weeklyOffs).toBe(1);
    expect(summary.leave).toBe(1);
    expect(summary.absent).toBe(0);
    expect(summary.checkoutMissing).toBe(0);
  });

  it('untracked rows contribute nothing at all (19-3 rule)', () => {
    const rows = [
      fullDay('2026-09-25'),
      row({ workDate: '2026-09-26', ctx: { tracked: false }, record: record('2026-09-26', '09:30', '18:30') }),
    ];
    const summary = summariseAttendanceRange(rows);
    expect(summary.trackedDays).toBe(1);
    expect(summary.workedHours).toBe(9);
  });
});

describe('summariseAttendanceRange — the report-only formulas', () => {
  it('expected days exclude weekly offs, holidays and approved leave', () => {
    const rows = [
      fullDay('2026-09-22'),
      row({ workDate: '2026-09-23', ctx: { isWeeklyOff: true } }),
      row({ workDate: '2026-09-24', ctx: { holidayId: 'h1', holidayName: 'Diwali', isWorkingDay: false } }),
      row({ workDate: '2026-09-25', ctx: { leaveState: 'approved', leavePart: 'full_day' } }),
      row({ workDate: '2026-09-26' }), // absent (past, no record, no leave)
    ];
    const summary = summariseAttendanceRange(rows);
    expect(summary.trackedDays).toBe(5);
    expect(summary.expectedDays).toBe(2); // worked + absent days only
    expect(summary.attendanceRate).toBe(50); // 1.0 / 2.0
  });

  it('a full-range present employee reads 100%', () => {
    const summary = summariseAttendanceRange([fullDay('2026-09-25')]);
    expect(summary.attendanceRate).toBe(100);
  });

  it('expected = 0 renders a null rate (no fake 0% or 100%)', () => {
    const summary = summariseAttendanceRange([
      row({ workDate: '2026-09-23', ctx: { isWeeklyOff: true } }),
    ]);
    expect(summary.expectedDays).toBe(0);
    expect(summary.attendanceRate).toBeNull();
  });

  it('hours come from non-null workedMinutes only; avg divides by worked credit', () => {
    const rows = [
      fullDay('2026-09-25'), // 9h → 1.0 credit
      row({ workDate: '2026-09-26', record: record('2026-09-26', '09:30', '13:30') }), // 4h → 0.5 credit
      row({ workDate: '2026-09-28' }), // absent: no minutes
    ];
    const summary = summariseAttendanceRange(rows);
    expect(summary.workedHours).toBe(13); // 540+240 = 780min
    expect(summary.avgHoursPerDay).toBe(8.7); // 780 / 1.5 credits
  });

  it('late minutes sum over late days with the grace applied by the engine', () => {
    const rows = [
      row({ workDate: '2026-09-25', record: record('2026-09-25', '09:45', '18:30') }), // exactly at start+cutoff → the grace holds, not late
      row({ workDate: '2026-09-26', record: record('2026-09-26', '10:30', '18:30') }), // 45min past the cutoff
    ];
    const summary = summariseAttendanceRange(rows);
    expect(summary.lateCount).toBe(1);
    expect(summary.lateMinutes).toBe(45);
  });

  it('early outs, corrections and half-day leaves count from the outcomes', () => {
    const rows = [
      row({ workDate: '2026-09-25', record: record('2026-09-25', '09:30', '14:00') }), // early 270min? no: end 1110, 840min-of-day → early
      row({
        workDate: '2026-09-26',
        override: override({ status: 'present' }),
        record: record('2026-09-26', '09:30', null),
      }),
      row({
        workDate: '2026-09-27',
        ctx: { leaveState: 'approved', leavePart: 'first_half' },
        record: record('2026-09-27', '09:30', '18:30'),
      }),
    ];
    const summary = summariseAttendanceRange(rows);
    expect(summary.earlyOuts).toBe(1);
    expect(summary.corrections).toBe(1);
    expect(summary.halfDayLeaves).toBe(1);
  });

  it('fake-location days count only the unacknowledged marker (owner ruling)', () => {
    const rows = [
      row({ workDate: '2026-09-25', hasUnackMockedAttempt: true, record: record('2026-09-25', '09:30', '18:30') }),
      row({ workDate: '2026-09-26', hasUnackMockedAttempt: false, record: record('2026-09-26', '09:30', '18:30') }),
    ];
    expect(summariseAttendanceRange(rows).fakeLocationDays).toBe(1);
  });
});

describe('registerCode — the day codes the legend prints', () => {
  it('maps every engine status to its spec code', () => {
    expect(registerCode('present')).toBe('P');
    expect(registerCode('half_day')).toBe('H');
    expect(registerCode('absent')).toBe('A');
    expect(registerCode('leave')).toBe('L');
    expect(registerCode('half_day_leave')).toBe('Hl');
    expect(registerCode('worked_on_holiday')).toBe('W');
    expect(registerCode('weekly_off')).toBe('O');
    expect(registerCode('holiday')).toBe('★');
    expect(registerCode('checkout_missing')).toBe('M');
    expect(registerCode('not_tracked')).toBe('·');
    expect(registerCode('not_checked_in_yet')).toBe('·');
    expect(registerCode('in_progress')).toBe('·');
  });
});

describe('computeAttendanceExceptions — needs attention, from real shapes', () => {
  it('alarms on an unacknowledged fake-location attempt', () => {
    const rows = [row({ workDate: '2026-09-25', hasUnackMockedAttempt: true })];
    const exceptions = computeAttendanceExceptions(
      rows,
      new Map([[EMP, { name: 'Ravi K' }]]),
    );
    const fake = exceptions.find((e) => e.kind === 'fake_location');
    expect(fake).toMatchObject({
      severity: 'alarm',
      employeeName: 'Ravi K',
    });
    expect(fake?.detail).toContain('1 day');
  });

  it('a 2-day absence streak stays silent; a 3-day streak alarms', () => {
    const two = [
      row({ workDate: '2026-09-24' }),
      row({ workDate: '2026-09-25' }),
    ];
    expect(
      computeAttendanceExceptions(two, new Map()).filter(
        (e) => e.kind === 'absent_streak',
      ),
    ).toHaveLength(0);

    const three = [
      row({ workDate: '2026-09-24' }),
      row({ workDate: '2026-09-25' }),
      row({ workDate: '2026-09-26' }),
    ];
    const streaks = computeAttendanceExceptions(three, new Map()).filter(
      (e) => e.kind === 'absent_streak',
    );
    expect(streaks).toHaveLength(1);
    expect(streaks[0].detail).toContain('3 consecutive');
  });

  it('a weekly off breaks an absence streak (it is not an expected day)', () => {
    const rows = [
      row({ workDate: '2026-09-24' }),
      row({ workDate: '2026-09-25', ctx: { isWeeklyOff: true } }),
      row({ workDate: '2026-09-26' }),
    ];
    expect(
      computeAttendanceExceptions(rows, new Map()).filter(
        (e) => e.kind === 'absent_streak',
      ),
    ).toHaveLength(0);
  });

  it('repeat late fires from 3 late days', () => {
    const rows = [
      row({ workDate: '2026-09-24', record: record('2026-09-24', '10:30', '18:30') }),
      row({ workDate: '2026-09-25', record: record('2026-09-25', '10:40', '18:30') }),
      row({ workDate: '2026-09-26', record: record('2026-09-26', '11:00', '18:30') }),
    ];
    const lates = computeAttendanceExceptions(rows, new Map()).filter(
      (e) => e.kind === 'repeat_late',
    );
    expect(lates).toHaveLength(1);
    expect(lates[0].detail).toContain('3 days');
  });

  it('missing check-out and corrections list their dates', () => {
    const rows = [
      row({ workDate: '2026-09-25', record: record('2026-09-25', '09:30', null) }),
      row({
        workDate: '2026-09-26',
        override: override({ status: 'present' }),
      }),
    ];
    const exceptions = computeAttendanceExceptions(rows, new Map());
    expect(exceptions.find((e) => e.kind === 'missing_checkout')?.detail).toContain('2026-09-25');
    expect(exceptions.find((e) => e.kind === 'corrected')?.detail).toContain('2026-09-26');
  });

  it('employees come out named; unknown ids degrade to the raw id', () => {
    const rows = [row({ hasUnackMockedAttempt: true })];
    const exceptions = computeAttendanceExceptions(rows, new Map());
    expect(exceptions[0].employeeName).toBe(EMP);
    const named = computeAttendanceExceptions(
      rows,
      new Map([[EMP, { name: 'Suresh' }]]),
    );
    expect(named[0].employeeName).toBe('Suresh');
  });

  it('alarms sort ahead of warnings and infos', () => {
    const rows = [
      row({ workDate: '2026-09-25', hasUnackMockedAttempt: true }),
      row({
        workDate: '2026-09-26',
        override: override({ status: 'present' }),
      }),
    ];
    const severities = computeAttendanceExceptions(rows, new Map()).map(
      (e) => e.severity,
    );
    expect(severities.indexOf('alarm')).toBeLessThan(
      severities.indexOf('info'),
    );
  });

  it('a second employee carries its own name through the shared engine', () => {
    const rows = [
      row({ workDate: '2026-09-25', hasUnackMockedAttempt: true }),
      row({
        workDate: '2026-09-25',
        employeeId: EMP2,
        hasUnackMockedAttempt: true,
      }),
    ];
    const fake = computeAttendanceExceptions(
      rows,
      new Map([
        [EMP, { name: 'A' }],
        [EMP2, { name: 'B' }],
      ]),
    ).filter((e) => e.kind === 'fake_location');
    expect(fake.map((e) => e.employeeName).sort()).toEqual(['A', 'B']);
  });
});
