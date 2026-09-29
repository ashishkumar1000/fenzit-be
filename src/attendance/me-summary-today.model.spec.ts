import {
  closedRecordView,
  openRecordView,
  pickTodayFacts,
} from './me-summary-today.model';
import type { OfficeRuleRow } from './me-summary.model';

/**
 * Pure-model spec for the 16-4 summary Today extension. Tester stance: the
 * requirement behaviours protected here are the HONEST NULLS (no rule →
 * late null, not a fabricated 0), the exact late/early/worked grading the
 * check-in/out responses promise (one implementation, summary included),
 * the tenant-offset instant contract (AD-7 — the FE renders wall-clock
 * parts and never converts), and the facts truth table (weekly off/holiday
 * → working day false). If the implementation changed but the requirement
 * did not, these must still pass.
 */

const rule = (
  overrides: Partial<OfficeRuleRow> = {},
): OfficeRuleRow => ({
  id: 'rule-1',
  valid: '[2026-01-01,)',
  start_time: '09:30:00',
  end_time: '18:00:00',
  late_cutoff_minutes: 15,
  ...overrides,
});

describe('pickTodayFacts — the pre-flight truth table', () => {
  it('a plain working day: isWorkingDay true, both off-flags false', () => {
    expect(pickTodayFacts([7], null, '2026-09-29')).toEqual({
      date: '2026-09-29',
      isWeeklyOff: false,
      isHoliday: false,
      holidayName: null,
      isWorkingDay: true,
    });
  });

  it('the employee weekly-off set marks the day (Tuesday when [2])', () => {
    expect(pickTodayFacts([2], null, '2026-09-29')).toMatchObject({
      isWeeklyOff: true,
      isWorkingDay: false,
    });
  });

  it('a holiday flips isWorkingDay off and carries the name', () => {
    expect(pickTodayFacts([], 'Diwali', '2026-09-29')).toMatchObject({
      isWeeklyOff: false,
      isHoliday: true,
      holidayName: 'Diwali',
      isWorkingDay: false,
    });
  });

  it('weekly off AND holiday together: both flags true, still not a working day', () => {
    expect(pickTodayFacts([2], 'Diwali', '2026-09-29')).toMatchObject({
      isWeeklyOff: true,
      isHoliday: true,
      isWorkingDay: false,
    });
  });

  it('an empty weekly-off set never marks a day off (works all week)', () => {
    expect(pickTodayFacts([], null, '2026-09-29')).toMatchObject({
      isWeeklyOff: false,
      isWorkingDay: true,
    });
  });
});

describe('openRecordView — checked in, not yet out', () => {
  const record = {
    work_date: '2026-09-29',
    checkin_at: '2026-09-29T10:22:00+05:30',
    checkout_at: null,
  };

  it('grades lateMinutes against the rule (10:22 vs 09:30+15 → 37, late)', () => {
    expect(openRecordView(record, 'Asia/Kolkata', rule())).toEqual({
      checkinAt: '2026-09-29T10:22:00+05:30',
      checkoutAt: null,
      lateMinutes: 37,
      isLate: true,
      workedMinutes: null,
      earlyCheckout: null,
      earlyCheckoutMinutes: null,
    });
  });

  it('within the grace (09:40 vs 09:30+15 → 0) is NOT late', () => {
    const r = openRecordView(
      { ...record, checkin_at: '2026-09-29T09:40:00+05:30' },
      'Asia/Kolkata',
      rule(),
    );
    expect(r.lateMinutes).toBe(0);
    expect(r.isLate).toBe(false);
  });

  it('NO rule covering today → lateMinutes/isLate honest nulls (D7), never a fabricated 0', () => {
    const r = openRecordView(record, 'Asia/Kolkata', null);
    expect(r.lateMinutes).toBeNull();
    expect(r.isLate).toBe(false);
  });

  it('the instant carries the tenant offset (+05:30), not a UTC Z', () => {
    const r = openRecordView(record, 'Asia/Kolkata', null);
    expect(r.checkinAt.endsWith('+05:30')).toBe(true);
  });

  it('a negative-offset zone formats its own offset (−08:00) — format, never convert', () => {
    const r = openRecordView(
      { ...record, checkin_at: '2026-09-29T18:22:00+05:30' },
      'America/Los_Angeles',
      null,
    );
    // 18:22 IST = 05:52 PDT (−07:00 in September).
    expect(r.checkinAt).toBe('2026-09-29T05:52:00-07:00');
  });
});

describe('closedRecordView — checked in and out', () => {
  const record = {
    work_date: '2026-09-29',
    checkin_at: '2026-09-29T10:22:00+05:30',
    checkout_at: '2026-09-29T18:05:00+05:30',
  };

  it('10:22→18:05 works 463 minutes; past the rule end → earlyCheckout false', () => {
    expect(closedRecordView(record, 'Asia/Kolkata', rule())).toMatchObject({
      workedMinutes: 463,
      earlyCheckout: false,
      earlyCheckoutMinutes: null,
      lateMinutes: 37,
      isLate: true,
    });
  });

  it('leaving before the rule end → earlyCheckout true + the minutes (17:00 vs 18:00 → 60)', () => {
    const r = closedRecordView(
      { ...record, checkout_at: '2026-09-29T17:00:00+05:30' },
      'Asia/Kolkata',
      rule(),
    );
    expect(r.earlyCheckout).toBe(true);
    expect(r.earlyCheckoutMinutes).toBe(60);
  });

  it('exactly AT the rule end is NOT early (boundary: 18:00 vs 18:00)', () => {
    const r = closedRecordView(
      { ...record, checkout_at: '2026-09-29T18:00:00+05:30' },
      'Asia/Kolkata',
      rule(),
    );
    expect(r.earlyCheckout).toBe(false);
  });

  it('sub-minute spans truncate to whole minutes (30 s → 0, never 1)', () => {
    const r = closedRecordView(
      {
        ...record,
        checkin_at: '2026-09-29T10:22:00+05:30',
        checkout_at: '2026-09-29T10:22:30+05:30',
      },
      'Asia/Kolkata',
      null,
    );
    expect(r.workedMinutes).toBe(0);
  });

  it('no rule → late and early honest nulls, but workedMinutes still grades', () => {
    const r = closedRecordView(record, 'Asia/Kolkata', null);
    expect(r.lateMinutes).toBeNull();
    expect(r.isLate).toBe(false);
    expect(r.earlyCheckout).toBe(false);
    expect(r.earlyCheckoutMinutes).toBeNull();
    expect(r.workedMinutes).toBe(463);
  });

  it('a checkout before the check-in (corrupt row) clamps to 0, never negative', () => {
    const r = closedRecordView(
      { ...record, checkout_at: '2026-09-29T09:00:00+05:30' },
      'Asia/Kolkata',
      null,
    );
    expect(r.workedMinutes).toBe(0);
  });
});
