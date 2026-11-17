import {
  isMonthKey,
  monthFirstDay,
  resolveEffective,
} from './effective-dating';

/**
 * Month-start resolution is the contract every payroll config story (4, 5)
 * and the run engine (6) leans on: the row in effect is the latest
 * effective_from on/before the run month's FIRST day — never the newest
 * save. A mid-month-dated row must therefore NOT be picked by the month it
 * is dated in.
 */

interface Row {
  effectiveFrom: string;
  label?: string;
}

const row = (effectiveFrom: string, label?: string): Row => ({
  effectiveFrom,
  label,
});

describe('resolveEffective — month-start resolution', () => {
  it('an empty set resolves to nothing (the caller decides what that means)', () => {
    expect(resolveEffective([], '2026-10')).toBeUndefined();
  });

  it('every row after the month resolves to nothing', () => {
    expect(
      resolveEffective(
        [row('2026-11-01', 'nov'), row('2026-12-01')],
        '2026-10',
      ),
    ).toBeUndefined();
  });

  it("a row dated exactly on the month's first day is in effect from that month", () => {
    const picked = resolveEffective(
      [row('2026-09-01', 'sep'), row('2026-11-01', 'nov')],
      '2026-10',
    );
    expect(picked?.label).toBe('sep');
  });

  it('a MID-MONTH-dated revision is invisible to the month it is dated in (whole-month rule)', () => {
    const picked = resolveEffective(
      [row('2026-09-01', 'sep'), row('2026-10-15', 'mid-oct')],
      '2026-10',
    );
    expect(picked?.label).toBe('sep');
    expect(
      resolveEffective(
        [row('2026-09-01', 'sep'), row('2026-10-15', 'mid-oct')],
        '2026-11',
      )?.label,
    ).toBe('mid-oct');
  });

  it('unordered input still resolves the latest qualifying row', () => {
    const picked = resolveEffective(
      [
        row('2026-11-01', 'nov'),
        row('2026-09-01', 'sep'),
        row('2026-10-01', 'oct'),
      ],
      '2026-11',
    );
    expect(picked?.label).toBe('nov');
  });

  it('February: a month key with any real month number works', () => {
    const picked = resolveEffective(
      [row('2025-12-01', 'dec'), row('2026-02-01', 'feb')],
      '2026-02',
    );
    expect(picked?.label).toBe('feb');
  });

  it('monthFirstDay is the plain calendar first day', () => {
    expect(monthFirstDay('2026-10')).toBe('2026-10-01');
  });
});

describe('isMonthKey', () => {
  it.each([
    ['2026-10', true],
    ['2026-01', true],
    ['2026-12', true],
    ['2026-13', false],
    ['2026-00', false],
    ['2026-1', false],
    ['26-10', false],
    ['2026-10-01', false],
    ['', false],
    [7, false],
    [null, false],
  ])('%p → %p', (value, expected) => {
    expect(isMonthKey(value)).toBe(expected);
  });
});
