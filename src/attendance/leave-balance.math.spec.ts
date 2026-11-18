import {
  accruedAnnual,
  accruedMonthly,
  carryableUnused,
  consumedByTypeFy,
  consumedForType,
  consumedKey,
  creditsByTypeYear,
  deriveTypeBalance,
  fyOf,
  fyWindow,
  insufficientBalanceMessage,
  monthsAccruedBetween,
  partWeight,
  walkCarryForward,
  type AccrualTypeConfig,
  type DayDebitRow,
} from './leave-balance.math';
import type { SpanDayFacts } from './leave.repository';

/**
 * The accrual arithmetic pins (23-13): FY naming (April-March), the
 * join-month-full accrual with its clamps (FY edges, as-of, leaver exit),
 * the part weighting, the floored carry-forward chain (credits + full-FY
 * accrual + prior CF - consumed, only from completed FYs), and the
 * bucket aggregation the service reads feed it.
 */

const working = (date: string): [string, SpanDayFacts] => [
  date,
  { date, isWorkingDay: true, kind: 'working' },
];
const off = (date: string): [string, SpanDayFacts] => [
  date,
  { date, isWorkingDay: false, kind: 'weekly_off' },
];

const type = (over: Partial<AccrualTypeConfig> = {}): AccrualTypeConfig => ({
  id: 'type-earned',
  code: 'earned',
  name: 'Earned Leave',
  accrualMode: 'monthly',
  accrualDays: 1,
  carryForward: true,
  allowOverBalance: false,
  enabled: true,
  ...over,
});

describe('FY helpers', () => {
  it('names a FY by its starting April year, April 1 being the boundary', () => {
    expect(fyOf('2026-04-01')).toBe(2026);
    expect(fyOf('2026-03-31')).toBe(2025);
    expect(fyOf('2027-01-15')).toBe(2026);
  });

  it('windows an FY from April 1 through March 31 of the next year', () => {
    expect(fyWindow(2026)).toEqual({ start: '2026-04-01', end: '2027-03-31' });
  });

  it('counts months inclusively and never backwards', () => {
    expect(monthsAccruedBetween('2026-04', '2026-04')).toBe(1);
    expect(monthsAccruedBetween('2026-04', '2026-09')).toBe(6);
    expect(monthsAccruedBetween('2026-04', '2027-03')).toBe(12);
    expect(monthsAccruedBetween('2026-04', '2026-03')).toBe(0);
  });
});

describe('accruedMonthly', () => {
  it('counts the join month in FULL — no day-level proration', () => {
    // Joins mid-May; May itself is a full month of accrual.
    expect(accruedMonthly(1, '2026-05-14', 2026, '2026-09-29')).toBe(5);
    expect(accruedMonthly(1, '2026-05-31', 2026, '2026-09-29')).toBe(5);
    expect(accruedMonthly(1, '2026-05-01', 2026, '2026-09-29')).toBe(5);
  });

  it('scales fractional rates (0.5/month sick)', () => {
    expect(accruedMonthly(0.5, '2026-04-01', 2026, '2026-05-31')).toBe(1);
    expect(accruedMonthly(0.5, '2026-04-01', 2026, '2026-09-29')).toBe(3);
  });

  it('a join before the FY accrues from the FY start, not the join month', () => {
    // January join inside FY 2026 (Jan-Mar 2026): FY 2026 starts April.
    expect(accruedMonthly(1, '2026-01-15', 2026, '2026-09-29')).toBe(6);
  });

  it('clamps at the FY end — a December as-of cannot accrue past March', () => {
    expect(accruedMonthly(2, '2026-05-01', 2026, '2027-07-01')).toBe(22);
  });

  it('a future FY accrues nothing yet (the as-of has not reached April)', () => {
    expect(accruedMonthly(1, '2026-05-01', 2027, '2026-09-29')).toBe(0);
    expect(accruedMonthly(1, '2026-05-01', 2026, '2026-03-15')).toBe(0);
  });

  it('a leaver stops accruing at the exit month once the exit has arrived', () => {
    expect(
      accruedMonthly(1, '2026-04-01', 2026, '2026-09-29', '2026-08-15'),
    ).toBe(5);
    // The full month of the exit counts (August included), nothing after.
    expect(
      accruedMonthly(1, '2026-04-01', 2026, '2026-09-29', '2026-08-01'),
    ).toBe(5);
    // A FUTURE exit does not clamp yet.
    expect(
      accruedMonthly(1, '2026-04-01', 2026, '2026-09-29', '2027-05-01'),
    ).toBe(6);
  });
});

describe('accruedAnnual + partWeight', () => {
  it('the annual grant is fixed and never negative', () => {
    expect(accruedAnnual(5)).toBe(5);
    expect(accruedAnnual(0)).toBe(0);
    expect(accruedAnnual(-3)).toBe(0);
  });

  it('full day 1, either half 0.5', () => {
    expect(partWeight('full_day')).toBe(1);
    expect(partWeight('first_half')).toBe(0.5);
    expect(partWeight('second_half')).toBe(0.5);
  });
});

describe('consumedByTypeFy', () => {
  it('weights full days 1 and halves 0.5, bucketed per type per FY', () => {
    const rows: DayDebitRow[] = [
      {
        leave_date: '2026-05-04',
        part: 'full_day',
        leave_type_id: 'type-earned',
      },
      {
        leave_date: '2026-05-05',
        part: 'second_half',
        leave_type_id: 'type-earned',
      },
      {
        leave_date: '2026-05-06',
        part: 'full_day',
        leave_type_id: 'type-earned',
      },
    ];
    const facts = new Map([
      working('2026-05-04'),
      working('2026-05-05'),
      working('2026-05-06'),
    ]);
    const consumed = consumedByTypeFy(rows, facts, new Set(['type-earned']));
    expect(consumed.get(consumedKey('type-earned', 2026))).toBe(2.5);
  });

  it('off days carry NO debit — a weekly-off row is skipped', () => {
    const rows: DayDebitRow[] = [
      {
        leave_date: '2026-05-10',
        part: 'full_day',
        leave_type_id: 'type-earned',
      },
    ];
    const facts = new Map([off('2026-05-10')]);
    const consumed = consumedByTypeFy(rows, facts, new Set(['type-earned']));
    expect(consumed.size).toBe(0);
  });

  it('rows of other types (and untyped rows) never land in this bucket', () => {
    const rows: DayDebitRow[] = [
      {
        leave_date: '2026-05-04',
        part: 'full_day',
        leave_type_id: 'type-other',
      },
      { leave_date: '2026-05-05', part: 'full_day', leave_type_id: null },
    ];
    const facts = new Map([working('2026-05-04'), working('2026-05-05')]);
    const consumed = consumedByTypeFy(rows, facts, new Set(['type-earned']));
    expect(consumed.size).toBe(0);
  });

  it('FY buckets split across March 31', () => {
    const rows: DayDebitRow[] = [
      {
        leave_date: '2027-03-31',
        part: 'full_day',
        leave_type_id: 'type-earned',
      },
      {
        leave_date: '2027-04-01',
        part: 'full_day',
        leave_type_id: 'type-earned',
      },
    ];
    const facts = new Map([working('2027-03-31'), working('2027-04-01')]);
    const consumed = consumedByTypeFy(rows, facts, new Set(['type-earned']));
    expect(consumed.get(consumedKey('type-earned', 2026))).toBe(1);
    expect(consumed.get(consumedKey('type-earned', 2027))).toBe(1);
  });

  it('a date missing from the facts map counts as working — a debit is never dropped', () => {
    const rows: DayDebitRow[] = [
      {
        leave_date: '2026-05-04',
        part: 'full_day',
        leave_type_id: 'type-earned',
      },
    ];
    const consumed = consumedByTypeFy(
      rows,
      new Map(),
      new Set(['type-earned']),
    );
    expect(consumed.get(consumedKey('type-earned', 2026))).toBe(1);
  });
});

describe('consumedForType + creditsByTypeYear', () => {
  it('slices the shared buckets back per FY for one type', () => {
    const consumed = new Map<string, number>([
      [consumedKey('type-earned', 2025), 3],
      [consumedKey('type-earned', 2026), 1.5],
      [consumedKey('type-sick', 2026), 4],
    ]);
    const byFy = consumedForType(consumed, 'type-earned');
    expect(byFy.get(2025)).toBe(3);
    expect(byFy.get(2026)).toBe(1.5);
    expect(byFy.size).toBe(2);
  });

  it('sums manual credits per type per FY, rounding each bucket once', () => {
    const credits = creditsByTypeYear([
      { user_id: 'u1', leave_type_id: 'type-earned', year: 2026, days: '5' },
      { user_id: 'u1', leave_type_id: 'type-earned', year: 2026, days: '-2.5' },
      { user_id: 'u1', leave_type_id: 'type-earned', year: 2025, days: '12' },
      { user_id: 'u1', leave_type_id: 'type-sick', year: 2026, days: '0.5' },
    ]);
    expect(credits.get('type-earned')?.get(2026)).toBe(2.5);
    expect(credits.get('type-earned')?.get(2025)).toBe(12);
    expect(credits.get('type-sick')?.get(2026)).toBe(0.5);
  });
});

describe('carryableUnused', () => {
  it('floors a negative unused balance at 0 — debt never carries', () => {
    expect(carryableUnused(-2)).toBe(0);
    expect(carryableUnused(-0.01)).toBe(0);
  });

  it('keeps a positive unused balance, rounded to 2dp', () => {
    expect(carryableUnused(3.5)).toBe(3.5);
    expect(carryableUnused(2.004)).toBe(2);
  });
});

describe('deriveTypeBalance', () => {
  it('derives the current FY: credits + as-of accrual - consumed (no prior FYs)', () => {
    // Join mid-FY 2026; no completed prior FY, no credits, no consumption.
    const derived = deriveTypeBalance(
      type(),
      '2026-05-01',
      null,
      '2026-09-29',
      new Map(),
      new Map(),
    );
    expect(derived).toEqual({
      credits: 0,
      accrued: 5,
      carryForward: 0,
      consumed: 0,
      remaining: 5,
    });
  });

  it('the completed prior FY carries its unused: credits + FULL-FY accrual - consumed, floored', () => {
    // Join June 2025 (FY 2025); FY 2025 completed with 2 credited, 11 consumed.
    const credits = new Map<number, number>([
      [2025, 2],
      [2026, 1.5],
    ]);
    const consumed = new Map<number, number>([
      [2025, 11],
      [2026, 2.5],
    ]);
    const derived = deriveTypeBalance(
      type(),
      '2025-06-10',
      null,
      '2026-09-29',
      credits,
      consumed,
    );
    // FY2025: full accrual Jun..Mar = 10; unused = 2 + 10 - 11 = 1 → carries 1.
    // FY2026 as-of: Apr..Sep = 6 (join month predates the FY start).
    expect(derived.carryForward).toBe(1);
    expect(derived.accrued).toBe(6);
    expect(derived.credits).toBe(1.5);
    expect(derived.consumed).toBe(2.5);
    expect(derived.remaining).toBe(6); // 1.5 + 6 + 1 - 2.5
  });

  it('CF chains through CF: a negative year carries 0, the next year carries its own', () => {
    // FY2023 over-consumed (unused -2 → floor 0), FY2024 under-consumed
    // (unused 7 → carries), FY2025 in progress.
    const credits = new Map<number, number>([[2025, 1]]);
    const consumed = new Map<number, number>([
      [2023, 14],
      [2024, 5],
      [2025, 2],
    ]);
    const derived = deriveTypeBalance(
      type(),
      '2023-04-01',
      null,
      '2025-06-15',
      credits,
      consumed,
    );
    // FY2023: 12 accrued - 14 consumed = -2 → 0 carried.
    // FY2024: 12 accrued + 0 - 5 = 7 → carried into FY2025.
    expect(derived.carryForward).toBe(7);
    // FY2025 accrued Apr..Jun = 3.
    expect(derived.remaining).toBe(1 + 3 + 7 - 2);
  });

  it('a CF-off type never carries (even a positive unused year)', () => {
    const derived = deriveTypeBalance(
      type({ carryForward: false }),
      '2025-04-01',
      null,
      '2026-06-15',
      new Map(),
      new Map([[2025, 1]]),
    );
    expect(derived.carryForward).toBe(0);
  });

  it('the annual grant accrues in full and ignores the exit clamp', () => {
    const derived = deriveTypeBalance(
      type({ accrualMode: 'annual', accrualDays: 5, carryForward: false }),
      '2026-01-01',
      '2026-08-15',
      '2026-09-29',
      new Map(),
      new Map(),
    );
    expect(derived.accrued).toBe(5);
    expect(derived.remaining).toBe(5);
  });

  it('the leaver clamp shapes the monthly accrual (current FY and the chain)', () => {
    // Exit Aug 15 2026; as-of after the exit: Apr..Aug = 5 months.
    const derived = deriveTypeBalance(
      type(),
      '2026-04-01',
      '2026-08-15',
      '2026-09-29',
      new Map(),
      new Map(),
    );
    expect(derived.accrued).toBe(5);
  });

  it('a type disabled or without a mode still derives (the caller filters)', () => {
    const derived = deriveTypeBalance(
      type({ enabled: false }),
      '2026-05-01',
      null,
      '2026-09-29',
      new Map(),
      new Map(),
    );
    expect(derived.accrued).toBe(5);
  });
});

describe('walkCarryForward', () => {
  it('hands the floored unused forward AND records each raw unused', () => {
    // FY2023 over-consumed (raw -2, floor carries 0); FY2024 under-
    // consumed (raw 12 + 0 - 5 = 7, carries 7). The raw map is what a
    // backdated check against a completed FY reads.
    const walk = walkCarryForward(
      type(),
      '2023-04-01',
      null,
      2025,
      new Map(),
      new Map([
        [2023, 14],
        [2024, 5],
      ]),
    );
    expect(walk.carryForward).toBe(7);
    expect(walk.unusedByFy.get(2023)).toBe(-2);
    expect(walk.unusedByFy.get(2024)).toBe(7);
    expect(walk.unusedByFy.size).toBe(2);
  });

  it('a CF-off type records the raw unused but never carries it', () => {
    const walk = walkCarryForward(
      type({ carryForward: false }),
      '2025-04-01',
      null,
      2026,
      new Map(),
      new Map([[2025, 9]]),
    );
    // FY2025 raw unused = 0 credits + 12 accrual - 9 consumed = 3 —
    // recorded but never carried.
    expect(walk.carryForward).toBe(0);
    expect(walk.unusedByFy.get(2025)).toBe(3);
  });

  it('the leaver clamp shapes a completed FY’s raw unused too', () => {
    const walk = walkCarryForward(
      type(),
      '2025-04-01',
      '2025-08-15',
      2026,
      new Map(),
      new Map(),
    );
    // Apr..Aug = 5 months.
    expect(walk.unusedByFy.get(2025)).toBe(5);
  });
});

describe('insufficientBalanceMessage', () => {
  it('carries both numbers in plain English', () => {
    expect(insufficientBalanceMessage('Earned Leave', 3.5, 4)).toBe(
      'Not enough Earned Leave balance — you have 3.5 days left and this request needs 4 days',
    );
    expect(insufficientBalanceMessage('Sick Leave', 0, 0.5)).toBe(
      'Not enough Sick Leave balance — you have 0 days left and this request needs 0.5 days',
    );
    // Exactly 1 reads singular — the plain-English copy rule.
    expect(insufficientBalanceMessage('Earned Leave', 1, 1)).toBe(
      'Not enough Earned Leave balance — you have 1 day left and this request needs 1 day',
    );
  });
});
