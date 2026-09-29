import {
  EMPTY_ME_SUMMARY,
  isSummarisableState,
  pickRuleForDate,
  pickWeeklyOffDays,
  rangeCovers,
  toMeSummaryResponse,
} from './me-summary.model';
import type { OfficeRuleRow, WeeklyOffRow } from './me-summary.model';

/**
 * Pure-model spec for 15-10 (FR-4 summary). Written as a tester: every case
 * names the requirement behaviour it protects — the daterange boundary
 * semantics (start inclusive / end exclusive), the weekly-off precedence
 * (override REPLACES default, AD-22; empty override days = works all week),
 * and the honest nulls when no rule covers. A change to the implementation
 * (not the requirement) must not turn these red.
 */

const rule = (
  id: string,
  valid: string,
  start_time = '09:30:00',
  end_time = '18:00:00',
  late_cutoff_minutes = 15,
): OfficeRuleRow => ({ id, valid, start_time, end_time, late_cutoff_minutes });

const wo = (valid: string, days: number[]): WeeklyOffRow => ({ valid, days });

describe('rangeCovers — the [a,b) daterange semantics', () => {
  it('a bounded range covers the anchor strictly inside it', () => {
    expect(rangeCovers('[2026-01-01,2027-01-01)', '2026-06-15')).toBe(true);
  });

  it('an unbounded range [a,) covers any anchor from a onward (the open period)', () => {
    expect(rangeCovers('[2026-01-01,)', '2026-01-01')).toBe(true);
    expect(rangeCovers('[2026-01-01,)', '2027-12-31')).toBe(true);
  });

  it('the start bound is INCLUSIVE (a rule applies from its first day)', () => {
    expect(rangeCovers('[2026-01-01,2027-01-01)', '2026-01-01')).toBe(true);
  });

  it('the end bound is EXCLUSIVE — the day after the range is NOT covered', () => {
    expect(rangeCovers('[2026-01-01,2027-01-01)', '2027-01-01')).toBe(false);
  });

  it('a fully past range does not cover today', () => {
    expect(rangeCovers('[2025-01-01,2025-12-31)', '2026-06-15')).toBe(false);
  });

  it('an empty-lower literal throws (parseDateRange contract — never silently cover everything)', () => {
    expect(() => rangeCovers('[,2027-01-01)', '2026-06-15')).toThrow(
      /Unparseable/,
    );
    expect(() => rangeCovers('not-a-range', '2026-06-15')).toThrow(
      /Unparseable/,
    );
  });
});

describe('pickRuleForDate — the rule effective on the anchor (FR-5)', () => {
  it('picks the rule whose range covers the anchor, wherever it sits in the set', () => {
    // The DB exclusion constraint guarantees at most one covering rule, so
    // first-match is deterministic — position in the array must not matter.
    const rules = [
      rule('past', '[2025-01-01,2025-06-01)'),
      rule('covering', '[2026-01-01,)'),
    ];
    expect(pickRuleForDate(rules, '2026-09-28')?.id).toBe('covering');
    expect(
      pickRuleForDate(
        [rule('covering', '[2026-01-01,)'), rule('past', '[2025-01-01,2025-06-01)')],
        '2026-09-28',
      )?.id,
    ).toBe('covering');
  });

  it('returns null when nothing covers — the fields surface as nulls, never a wrong rule', () => {
    expect(
      pickRuleForDate([rule('past', '[2025-01-01,2025-06-01)')], '2026-09-28'),
    ).toBeNull();
    expect(pickRuleForDate([], '2026-09-28')).toBeNull();
  });
});

describe('pickWeeklyOffDays — override REPLACES default while covering (AD-22)', () => {
  it('a covering override wins over the tenant default (precedence)', () => {
    const days = pickWeeklyOffDays(
      [wo('[2026-01-01,)', [3])],
      [wo('[2026-01-01,)', [7])],
      '2026-06-15',
    );
    expect(days).toEqual([3]);
  });

  it('an override with EMPTY days means works-all-week — the default must NOT leak through', () => {
    const days = pickWeeklyOffDays(
      [wo('[2026-01-01,)', [])],
      [wo('[2026-01-01,)', [7])],
      '2026-06-15',
    );
    expect(days).toEqual([]);
  });

  it('no covering override falls through to the covering tenant default', () => {
    // The override exists but starts tomorrow — today shows the default.
    const days = pickWeeklyOffDays(
      [wo('[2026-09-29,)', [1])],
      [wo('[2026-01-01,)', [7])],
      '2026-09-28',
    );
    expect(days).toEqual([7]);
  });

  it('no covering override AND no covering default (or no rows at all) is [] — all 7 days worked', () => {
    expect(pickWeeklyOffDays([], [], '2026-09-28')).toEqual([]);
    expect(
      pickWeeklyOffDays(
        [wo('[2027-01-01,)', [1])],
        [wo('[2025-01-01,2025-06-01)', [7])],
        '2026-09-28',
      ),
    ).toEqual([]);
  });

  it('sorts the days ascending even when the row stored them unsorted', () => {
    expect(
      pickWeeklyOffDays([], [wo('[2026-01-01,)', [7, 1])], '2026-09-28'),
    ).toEqual([1, 7]);
    expect(
      pickWeeklyOffDays([wo('[2026-01-01,)', [5, 2, 7])], [], '2026-09-28'),
    ).toEqual([2, 5, 7]);
  });

  it('does not mutate the stored rows (sorting works on a copy)', () => {
    const stored = wo('[2026-01-01,)', [7, 1]);
    pickWeeklyOffDays([stored], [], '2026-09-28');
    expect(stored.days).toEqual([7, 1]);
  });
});

describe('isSummarisableState — the endpoint serves active/upcoming only', () => {
  it.each([
    ['active', true],
    ['upcoming', true],
    ['none', false],
    ['history_only', false],
  ])('%s → %s', (state, expected) => {
    expect(isSummarisableState(state as never)).toBe(expected);
  });
});

describe('toMeSummaryResponse', () => {
  const row = {
    office_id: 'office-1',
    office_name: 'Thane',
  };
  const today = {
    date: '2026-09-29',
    isWeeklyOff: false,
    isHoliday: false,
    holidayName: null,
    isWorkingDay: true,
  };
  const todayRecord = {
    checkinAt: '2026-09-29T10:22:00+05:30',
    checkoutAt: null,
    lateMinutes: 0,
    isLate: false,
    workedMinutes: null,
    earlyCheckout: null,
    earlyCheckoutMinutes: null,
  };

  it('truncates pg time values to HH:mm and passes office/cutoff/weekly-off fields through', () => {
    expect(
      toMeSummaryResponse({
        row,
        rule: rule('r1', '[2026-01-01,)', '09:30:00', '18:00:00', 15),
        weeklyOffDays: [7],
        officePin: { latitude: 19.076, longitude: 72.8777 },
        today,
        todayRecord,
      }),
    ).toEqual({
      officeId: 'office-1',
      officeName: 'Thane',
      startTime: '09:30',
      endTime: '18:00',
      lateCutOffMinutes: 15,
      weeklyOffDays: [7],
      officeLatitude: 19.076,
      officeLongitude: 72.8777,
      today,
      todayRecord,
    });
  });

  it('a null rule nulls every time/cutoff field but the office fields still pass through', () => {
    expect(
      toMeSummaryResponse({
        row,
        rule: null,
        weeklyOffDays: [1, 7],
        officePin: null,
        today: null,
        todayRecord: null,
      }),
    ).toEqual({
      officeId: 'office-1',
      officeName: 'Thane',
      startTime: null,
      endTime: null,
      lateCutOffMinutes: null,
      weeklyOffDays: [1, 7],
      officeLatitude: null,
      officeLongitude: null,
      today: null,
      todayRecord: null,
    });
  });
});

describe('EMPTY_ME_SUMMARY — the honest empty for none/history_only', () => {
  it('is the exact all-null/[] payload (incl. the 16-4 Today extension)', () => {
    expect(EMPTY_ME_SUMMARY).toEqual({
      officeId: null,
      officeName: null,
      startTime: null,
      endTime: null,
      lateCutOffMinutes: null,
      weeklyOffDays: [],
      officeLatitude: null,
      officeLongitude: null,
      today: null,
      todayRecord: null,
    });
  });

  it('shape lock: a field added to the response later without updating this spec is contract drift', () => {
    expect(Object.keys(EMPTY_ME_SUMMARY).sort()).toEqual([
      'endTime',
      'lateCutOffMinutes',
      'officeId',
      'officeLatitude',
      'officeLongitude',
      'officeName',
      'startTime',
      'today',
      'todayRecord',
      'weeklyOffDays',
    ]);
  });
});
