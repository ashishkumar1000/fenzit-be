import {
  applyEnableDayGrace,
  assembleDayContext,
  computeEarlyCheckoutMinutes,
  computeLateMinutes,
  computeMidpointMinute,
  dateInTz,
  isoWeekdayOf,
  minuteOfDayInTz,
  timeStringToMinutes,
  isWeeklyOffDay,
  DayFacts,
} from './day-context';
import { OfficeRuleRow } from './me-summary.model';

/**
 * The AD-22 day context's pure half (16-1). The SQL reads live behind
 * `buildDayContext` and are covered by the real-DB journey; everything
 * consumers depend on — tracked/grace, rule picking, midpoints, late and
 * early math — is pinned here.
 */

const IST = 'Asia/Kolkata';

function rule(overrides: Partial<OfficeRuleRow> = {}): OfficeRuleRow {
  return {
    id: 'rule-1',
    valid: '[2026-01-01,)',
    start_time: '09:00:00',
    end_time: '18:00:00',
    late_cutoff_minutes: 15,
    ...overrides,
  };
}

function facts(overrides: Partial<DayFacts> = {}): DayFacts {
  return {
    enrolmentCovers: true,
    setupCompleted: true,
    enabled: true,
    enabledAt: new Date('2026-09-01T04:00:00Z'),
    enrolmentStart: '2026-09-01',
    rule: rule(),
    weeklyOffDays: [],
    holidayId: null,
    holidayName: null,
    ...overrides,
  };
}

describe('wall-clock extraction (AD-7 — Intl, never a tz library)', () => {
  it('reads tenant-local minutes east of UTC', () => {
    expect(minuteOfDayInTz(new Date('2026-09-28T04:00:00Z'), IST)).toBe(9 * 60 + 30);
  });

  it('reads tenant-local minutes west of UTC (day shifts back)', () => {
    expect(
      minuteOfDayInTz(new Date('2026-09-28T04:00:00Z'), 'America/New_York'),
    ).toBe(0 * 60 + 0); // 04:00Z = 00:00 EDT (UTC-4)
  });

  it('is exact at UTC itself', () => {
    expect(minuteOfDayInTz(new Date('2026-09-28T23:05:00Z'), 'UTC')).toBe(23 * 60 + 5);
  });

  it('gives the tenant-local calendar date', () => {
    expect(dateInTz(new Date('2026-09-28T20:30:00Z'), IST)).toBe('2026-09-29');
    expect(dateInTz(new Date('2026-09-28T20:30:00Z'), 'UTC')).toBe('2026-09-28');
  });

  it('rejects an unknown timezone loudly', () => {
    expect(() => minuteOfDayInTz(new Date(), 'Mars/Olympus')).toThrow();
  });
});

describe('calendar helpers', () => {
  it.each([
    ['2026-09-28', 1], // Monday
    ['2026-09-27', 7], // Sunday
    ['2026-09-26', 6], // Saturday
  ])('isoWeekdayOf(%s) = %i (1=Mon..7=Sun)', (date, expected) => {
    expect(isoWeekdayOf(date)).toBe(expected);
  });

  it.each([
    ['09:00:00', 540],
    ['09:30', 570],
    ['00:00:00', 0],
  ])('timeStringToMinutes(%s) = %i', (value, expected) => {
    expect(timeStringToMinutes(value)).toBe(expected);
  });

  it('midpoint truncates to the minute (AD-22)', () => {
    expect(computeMidpointMinute(9 * 60, 18 * 60)).toBe(13 * 60 + 30);
    // Odd span: start + trunc((end−start)/2) — never rounds up.
    expect(computeMidpointMinute(9 * 60 + 1, 18 * 60)).toBe(13 * 60 + 30);
  });

  it('isWeeklyOffDay matches ISO weekday numbers', () => {
    expect(isWeeklyOffDay([7], '2026-09-27')).toBe(true); // Sunday
    expect(isWeeklyOffDay([7], '2026-09-28')).toBe(false); // Monday
    expect(isWeeklyOffDay([], '2026-09-27')).toBe(false);
  });
});

describe('late and early math (D12)', () => {
  it('late = 0 within the Start + cut-off grace', () => {
    expect(computeLateMinutes(9 * 60 + 15, 9 * 60, 15)).toBe(0);
    expect(computeLateMinutes(9 * 60, 9 * 60, 15)).toBe(0);
  });

  it('late counts strictly beyond Start + cut-off', () => {
    expect(computeLateMinutes(9 * 60 + 16, 9 * 60, 15)).toBe(1);
    expect(computeLateMinutes(10 * 60, 9 * 60, 15)).toBe(45);
  });

  it('cut-off 0 means late strictly after Start', () => {
    expect(computeLateMinutes(9 * 60, 9 * 60, 0)).toBe(0);
    expect(computeLateMinutes(9 * 60 + 1, 9 * 60, 0)).toBe(1);
  });

  it('early-checkout minutes measure the gap before End', () => {
    expect(computeEarlyCheckoutMinutes(17 * 60, 18 * 60)).toBe(60);
    expect(computeEarlyCheckoutMinutes(18 * 60, 18 * 60)).toBeNull();
    expect(computeEarlyCheckoutMinutes(18 * 60 + 1, 18 * 60)).toBeNull();
  });
});

describe('FR-2 enable-day grace (D10)', () => {
  const monday = '2026-09-28';

  it('not tracked without enrolment/setup/enabled regardless of grace', () => {
    expect(
      applyEnableDayGrace(facts({ enrolmentCovers: false }), rule(), monday, IST, true)
        .tracked,
    ).toBe(false);
    expect(
      applyEnableDayGrace(facts({ enabled: false }), rule(), monday, IST, false)
        .tracked,
    ).toBe(false);
  });

  it('any check-in on the enable day makes it tracked (FR-2 carve-out)', () => {
    // Enabled 11:00 IST after a 09:00 start — still tracked when checking in.
    const { tracked } = applyEnableDayGrace(
      facts({ enabledAt: new Date('2026-09-28T05:30:00Z') }),
      rule(),
      monday,
      IST,
      true,
    );
    expect(tracked).toBe(true);
  });

  it('enabled after Start with NO check-in on the enable day is untracked', () => {
    const { tracked, graceBlocks } = applyEnableDayGrace(
      facts({ enabledAt: new Date('2026-09-28T05:30:00Z') }), // 11:00 IST
      rule(),
      monday,
      IST,
      false,
    );
    expect(tracked).toBe(false);
    expect(graceBlocks).toBe(true);
  });

  it('enabled before Start on the enable day is tracked', () => {
    const { tracked } = applyEnableDayGrace(
      facts({ enabledAt: new Date('2026-09-28T03:00:00Z') }), // 08:30 IST
      rule(),
      monday,
      IST,
      false,
    );
    expect(tracked).toBe(true);
  });

  it('an enabled_at on a LATER day never blocks', () => {
    const { tracked } = applyEnableDayGrace(
      facts({ enabledAt: new Date('2026-10-01T05:30:00Z') }),
      rule(),
      monday,
      IST,
      false,
    );
    expect(tracked).toBe(true);
  });

  it('no covering rule → grace cannot be judged → tracked', () => {
    const { tracked } = applyEnableDayGrace(
      facts({ enabledAt: new Date('2026-09-28T05:30:00Z') }),
      null,
      monday,
      IST,
      false,
    );
    expect(tracked).toBe(true);
  });

  it('grace compares TRUNCATED minutes — sub-minute enabled_at is pinned (review nit)', () => {
    // enabled at 00:00:59 IST vs a 00:00 start → truncates to minute 0 →
    // NOT after start → tracked without a check-in.
    const at59s = applyEnableDayGrace(
      facts({ enabledAt: new Date('2026-09-27T18:30:59Z') }), // 00:00:59 IST Tue
      rule({ start_time: '00:00:00' }),
      '2026-09-29',
      IST,
      false,
    );
    expect(at59s.graceBlocks).toBe(false);
    // enabled at 10:00:59 vs a 10:00 start → same minute → not blocked.
    const sameMinute = applyEnableDayGrace(
      facts({ enabledAt: new Date('2026-09-28T04:30:59Z') }), // 10:00:59 IST
      rule({ start_time: '10:00:00' }),
      monday,
      IST,
      false,
    );
    expect(sameMinute.graceBlocks).toBe(false);
    // one full minute later → blocked.
    const nextMinute = applyEnableDayGrace(
      facts({ enabledAt: new Date('2026-09-28T04:31:00Z') }), // 10:01 IST
      rule({ start_time: '10:00:00' }),
      monday,
      IST,
      false,
    );
    expect(nextMinute.graceBlocks).toBe(true);
  });
});

describe('assembleDayContext', () => {
  it('exposes office pin/radius and the covering rule in minutes', () => {
    const ctx = assembleDayContext(
      'tenant-1',
      'emp-1',
      '2026-09-28',
      IST,
      facts(),
      {
        office_id: 'office-1',
        office_name: 'Thane',
        office_lat: 19.076,
        office_lng: 72.8777,
        radius_m: 100,
      },
      true,
    );
    expect(ctx.tracked).toBe(true);
    expect(ctx.officeId).toBe('office-1');
    expect(ctx.radiusM).toBe(100);
    expect(ctx.startMinute).toBe(540);
    expect(ctx.endMinute).toBe(1080);
    expect(ctx.midpointMinute).toBe(810);
    expect(ctx.lateCutoffMinutes).toBe(15);
    expect(ctx.isWorkingDay).toBe(true);
    expect(ctx.leavePart).toBeNull(); // Epic 17 seam
  });

  it('flags weekly offs and holidays and flips isWorkingDay', () => {
    const off = assembleDayContext(
      'tenant-1',
      'emp-1',
      '2026-09-27', // Sunday
      IST,
      facts({ weeklyOffDays: [7] }),
      null,
      false,
    );
    expect(off.isWeeklyOff).toBe(true);
    expect(off.isWorkingDay).toBe(false);

    const holiday = assembleDayContext(
      'tenant-1',
      'emp-1',
      '2026-09-28',
      IST,
      facts({ holidayId: 'h-1', holidayName: 'Diwali' }),
      null,
      false,
    );
    expect(holiday.holidayId).toBe('h-1');
    expect(holiday.holidayName).toBe('Diwali');
    expect(holiday.isWorkingDay).toBe(false);
  });

  it('no covering rule (D7) → null rule facts, still tracked', () => {
    const ctx = assembleDayContext(
      'tenant-1',
      'emp-1',
      '2026-09-28',
      IST,
      facts({ rule: null }),
      {
        office_id: 'office-1',
        office_name: 'Thane',
        office_lat: 19.076,
        office_lng: 72.8777,
        radius_m: 100,
      },
      true,
    );
    expect(ctx.tracked).toBe(true);
    expect(ctx.officeRulesId).toBeNull();
    expect(ctx.startMinute).toBeNull();
    expect(ctx.endMinute).toBeNull();
    expect(ctx.midpointMinute).toBeNull();
    expect(ctx.lateCutoffMinutes).toBeNull();
  });
});
