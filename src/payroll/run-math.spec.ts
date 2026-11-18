import {
  capClamp,
  earnings,
  earnedLine,
  monthsEmployedInFy,
  tdsProjection,
} from './run-math';
import { assembleLop } from './run-lop';
import { capPayable, lopWindow, payableWindow } from './run-window';

/** The canonical fixture's window/LOP/money arithmetic, verbatim. */
describe('run-window — the fixture day-counts', () => {
  const cutoff = () => 25; // the fixture default
  const fullEmployment = { joinDate: '2026-09-01', exitDate: null };

  it('October for employee A: the month (31 days) capped to 26, keeping the earliest', () => {
    const window = payableWindow(fullEmployment, '2026-10');
    expect(window).toHaveLength(31);
    expect(window[0]).toBe('2026-10-01');
    const kept = capPayable(window, 26);
    expect(kept).toHaveLength(26);
    expect(kept[25]).toBe('2026-10-26');
  });

  it('September for employee A: the month, 30 days (the fixture text says 25 — flagged for the owner; the asserted PF is identical)', () => {
    const window = payableWindow(fullEmployment, '2026-09');
    expect(window[0]).toBe('2026-09-01');
    expect(window).toHaveLength(30);
  });

  it('the LOP window reaches into the prior month post-cut-off (November owns Oct 26–31)', () => {
    const lop = lopWindow(fullEmployment, '2026-11', cutoff);
    expect(lop[0]).toBe('2026-10-26');
    // November's own post-cut-off days (26–30) are December's run's.
    expect(lop.at(-1)).toBe('2026-11-25');
    expect(lop).toHaveLength(31);
  });

  it('variant C: joined Oct 20 → 12 payable days (Oct 20–31)', () => {
    const window = payableWindow(
      { joinDate: '2026-10-20', exitDate: null },
      '2026-10',
    );
    expect(window).toHaveLength(12);
    expect(window[0]).toBe('2026-10-20');
    expect(window[11]).toBe('2026-10-31');
  });

  it('variant C2: exit Oct 10 → 10 payable days (the month only)', () => {
    const window = payableWindow(
      { joinDate: '2026-09-01', exitDate: '2026-10-10' },
      '2026-10',
    );
    expect(window).toHaveLength(10);
    expect(window[0]).toBe('2026-10-01');
    expect(window[9]).toBe('2026-10-10');
  });

  it('cut-off 20 re-scopes the ownership boundary (the Oct-22 leave lands in November)', () => {
    const cutoff20 = () => 20;
    const owned = lopWindow(fullEmployment, '2026-10', cutoff20);
    expect(owned).not.toContain('2026-10-22');
    expect(owned).toContain('2026-10-20');
    // The payable month is untouched by the cut-off: still 31 → capped 26.
    expect(payableWindow(fullEmployment, '2026-10')).toHaveLength(31);
  });

  it('the divisor cap discards the tail: pay and LOP alike', () => {
    const window = payableWindow(fullEmployment, '2026-10');
    expect(capPayable(window, 30)[29]).toBe('2026-10-30');
    expect(capPayable(window, 31)[30]).toBe('2026-10-31');
  });
});

describe('run-lop — the fixture LOP counts', () => {
  const leaveStatuses = new Map(
    [
      ['2026-10-06', 'leave'],
      ['2026-10-07', 'leave'],
      ['2026-10-12', 'half_day_leave'],
      ['2026-10-13', 'leave'],
      ['2026-10-14', 'leave'],
      ['2026-10-15', 'leave'],
      ['2026-10-10', 'half_day_leave'],
    ].map(([d, s]) => [d, { status: s as never, tracked: true }]),
  );
  const leaves = new Map([
    ['2026-10-06', { date: '2026-10-06', unpaid: false, half: false }],
    ['2026-10-07', { date: '2026-10-07', unpaid: false, half: false }],
    ['2026-10-12', { date: '2026-10-12', unpaid: true, half: true }],
    ['2026-10-13', { date: '2026-10-13', unpaid: true, half: false }],
    ['2026-10-14', { date: '2026-10-14', unpaid: true, half: false }],
    ['2026-10-15', { date: '2026-10-15', unpaid: true, half: false }],
    ['2026-10-10', { date: '2026-10-10', unpaid: false, half: true }],
  ]);

  it('base variant: 3 unpaid + 0.5 unpaid half = 3.5 (paid leaves contribute zero)', () => {
    const kept = capPayable(
      payableWindow(
        { joinDate: '2026-09-01', exitDate: null },
        '2026-10',
        () => 25,
      ),
      26,
    );
    const result = assembleLop(kept, leaveStatuses, leaves, new Map());
    expect(result.lopDays).toBe(3.5);
    expect(result.flags).toHaveLength(0);
  });

  it('variant I: the absent day (no leave) is the only LOP; the paid half is not', () => {
    const kept = ['2026-10-03', '2026-10-10', '2026-10-20'];
    const withAbsent = new Map(leaveStatuses);
    withAbsent.set('2026-10-20', { status: 'absent' as never, tracked: true });
    const result = assembleLop(kept, withAbsent, leaves, new Map());
    expect(result.lopDays).toBe(1);
  });

  it('the owner override replaces the leave-derived treatment', () => {
    const kept = ['2026-10-12', '2026-10-13'];
    const overrides = new Map([
      ['2026-10-13', { date: '2026-10-13', status: 'present' as const }],
    ]);
    const result = assembleLop(kept, leaveStatuses, leaves, overrides);
    expect(result.lopDays).toBe(0.5); // the unpaid half stands; the full day is worked
  });

  it('an owner half_day correction adds its half (the owner-corrected fixture row)', () => {
    const kept = ['2026-10-21'];
    const result = assembleLop(
      kept,
      new Map([['2026-10-21', { status: 'present' as never, tracked: true }]]),
      new Map(),
      new Map([
        ['2026-10-21', { date: '2026-10-21', status: 'half_day' as const }],
      ]),
    );
    expect(result.lopDays).toBe(0.5);
  });

  it('checkout_missing is paid and flagged, never LOP', () => {
    const kept = ['2026-10-16'];
    const result = assembleLop(
      kept,
      new Map([
        ['2026-10-16', { status: 'checkout_missing' as never, tracked: true }],
      ]),
      new Map(),
      new Map(),
    );
    expect(result.lopDays).toBe(0);
    expect(result.flags[0]).toContain('checkout_missing');
  });

  it('attendance gaps inside a partially-tracked window are paid and flagged', () => {
    const kept = ['2026-10-09'];
    const result = assembleLop(
      kept,
      new Map([
        ['2026-10-09', { status: 'not_tracked' as never, tracked: false }],
      ]),
      new Map(),
      new Map(),
    );
    expect(result.lopDays).toBe(0);
    expect(result.flags[0]).toContain('no attendance data');
  });
});

describe('run-math — the fixture money rows', () => {
  it('base earnings: 28,000 ÷ 26 × 22.5 = 24,230.77', () => {
    expect(earnings(28000, 26, 22.5)).toBe('24230.77');
  });

  it('a full month with no LOP yields exactly the structure amount under every divisor', () => {
    expect(earnings(28000, 26, 26)).toBe('28000.00');
    expect(earnings(28000, 30, 30)).toBe('28000.00');
    expect(earnings(28000, 31, 31)).toBe('28000.00');
  });

  it('the divisor table: fixed-30 → 24,733.33; calendar → 24,838.71', () => {
    expect(earnings(28000, 30, 26.5)).toBe('24733.33');
    expect(earnings(28000, 31, 27.5)).toBe('24838.71');
  });

  it('earned basic line: 20,000 ÷ 26 × 22.5 = 17,307.69', () => {
    expect(earnedLine(20000, 26, 22.5)).toBe('17307.69');
  });

  it('variant D cap clamp: 14,761.54 → 12,115.39, net 12,115.38, excess 2,646.15', () => {
    const result = capClamp(
      [
        { source: 'pf_employee', amount: 2076.92 },
        { source: 'tds', amount: 12000 },
        { source: 'head:Insurance', amount: 484.62 },
        { source: 'head:Professional Tax', amount: 200 },
      ],
      24230.77,
    );
    expect(result.totalDeductions).toBe('12115.39');
    expect(result.netWages).toBe('12115.38');
    expect(result.excess).toBe('2646.15');
    const sum = result.lines.reduce((s, l) => s + l.amount, 0);
    expect(Math.round(sum * 100) / 100).toBe(12115.39);
  });

  it('an unbinding cap leaves the lines untouched', () => {
    const lines = [{ source: 'head:PT', amount: 200 }];
    const result = capClamp(lines, 24230.77);
    expect(result.excess).toBe('0.00');
    expect(result.totalDeductions).toBe('200.00');
    expect(result.netWages).toBe('24030.77');
  });

  it('TDS projection: fixture A (28,000 × 7 − 75,000) → 0.00; H → 20,973.33', () => {
    expect(
      tdsProjection({
        monthlyStructure: 28000,
        monthsEmployedInFy: 7,
        remainingFyMonths: 7,
        priorFyTds: 0,
      }),
    ).toBe('0.00');
    expect(
      tdsProjection({
        monthlyStructure: 280000,
        monthsEmployedInFy: 6,
        remainingFyMonths: 6,
        priorFyTds: 0,
      }),
    ).toBe('20973.33');
  });

  it('the re-spread: annual − prior TDS over the remaining months', () => {
    // H again, but October already deducted 20,973.33: November spreads the
    // rest (1,25,840 − 20,973.33 = 1,04,866.67) over the 5 remaining months.
    expect(
      tdsProjection({
        monthlyStructure: 280000,
        monthsEmployedInFy: 6,
        remainingFyMonths: 5,
        priorFyTds: 20973.33,
      }),
    ).toBe('20973.33'); // (104,866.67 ÷ 5) = 20,973.334 → 20,973.33
  });

  it('a leaver (C2, exit Oct 10) has employment months ending at exit month', () => {
    expect(monthsEmployedInFy('2026-09-01', '2026-10-10')).toBe(2);
    expect(monthsEmployedInFy('2026-10-20', null)).toBe(6);
    expect(monthsEmployedInFy('2026-09-01', null)).toBe(7);
    expect(monthsEmployedInFy('2026-04-01', null)).toBe(12);
  });
});
