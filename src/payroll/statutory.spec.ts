import {
  annualTax,
  FY_2026_27_SLABS,
  pfDeduction,
  pfWageCeiling,
  tdsConfigView,
  tdsPerMonth,
} from './statutory';

/**
 * The canonical fixture's statutory rows, verbatim (canonical-fixture.md is
 * the test oracle): variant A's 2,076.92, variant C's 1,107.69, variant H's
 * ceiling-bound 3,000.00 and 20,973.33/month, and the September row's
 * ceiling-resolved 1,800.00. Every number below is quoted from the fixture.
 */
describe('statutory — PF (fixture oracle)', () => {
  it('variant A: 12% × min(earned basic 17,307.69, ceiling 25,000) = 2,076.92, employer recorded equal', () => {
    expect(pfDeduction('17307.69', '25000.00')).toEqual({
      employee: '2076.92',
      employer: '2076.92',
    });
  });

  it('variant C: the 12-day joiner — 12% × 9,230.77 = 1,107.69', () => {
    expect(pfDeduction('9230.77', '25000.00').employee).toBe('1107.69');
  });

  it('variant H: the ceiling BINDS — 12% × min(2,00,000, 25,000) = 3,000.00, never 12% of full basic', () => {
    expect(pfDeduction('200000.00', '25000.00').employee).toBe('3000.00');
  });

  it.each([
    ['2026-08', '15000.00'],
    ['2026-09', '15000.00'],
    ['2026-10', '25000.00'],
    ['2027-03', '25000.00'],
  ])('the wage ceiling for %s resolves to %s (month-start)', (month, want) => {
    expect(pfWageCeiling(month)).toBe(want);
  });

  it('the September row: 12% × min(19,230.77, 15,000) = 1,800.00 — the ceiling binds under the OLD value', () => {
    expect(pfDeduction('19230.77', pfWageCeiling('2026-09')).employee).toBe(
      '1800.00',
    );
  });

  it('PF on the fixture divisor table and the half-day row: every earned basic reproduces its paise', () => {
    // canonical-fixture.md divisor table + owner-corrected half-day row.
    expect(pfDeduction('17666.67', '25000.00').employee).toBe('2120.00');
    expect(pfDeduction('17741.94', '25000.00').employee).toBe('2129.03');
    expect(pfDeduction('16923.08', '25000.00').employee).toBe('2030.77');
  });

  it('a malformed month is refused loudly, never silently mis-resolved', () => {
    // '2026-9' string-compares AFTER '2026-09-17' and would hand September
    // the ₹25,000 ceiling four months early.
    expect(() => pfWageCeiling('2026-9')).toThrow('YYYY-MM');
    expect(() => pfWageCeiling('september')).toThrow('YYYY-MM');
    expect(() => pfWageCeiling('2026-00')).toThrow('YYYY-MM');
  });

  it('non-numeric money text refuses loudly instead of emitting "NaN"', () => {
    expect(() => pfDeduction('abc', '25000.00')).toThrow();
    expect(() => annualTax('abc')).toThrow();
    expect(() => tdsPerMonth('abc', 6)).toThrow();
    expect(() => tdsPerMonth('Infinity', 6)).toThrow();
  });

  it('negative statutory inputs refuse loudly — no negative money leaves the module', () => {
    expect(() => pfDeduction('-100.00', '25000.00')).toThrow();
    expect(() => annualTax('-5.00')).toThrow();
    expect(() => tdsPerMonth('-10.00', 6)).toThrow();
  });
});

describe('statutory — TDS annual (fixture oracle)', () => {
  it('fixture A: taxable 1,21,000 is below ₹4 lakh — TDS 0.00', () => {
    expect(annualTax('121000.00').total).toBe('0.00');
  });

  it('income up to ₹12 lakh pays nothing — the s.157 rebate wipes the slab tax', () => {
    const row = annualTax('1100000.00');
    expect(row).toMatchObject({
      tax: '50000.00',
      rebate: '50000.00',
      cess: '0.00',
      marginalRelief: '0.00',
      total: '0.00',
    });
  });

  it('the ₹12,00,000 boundary itself: tax 60,000, rebate 60,000, total 0.00', () => {
    expect(annualTax('1200000.00').total).toBe('0.00');
  });

  it('fixture H: taxable 16,05,000 → tax 1,21,000 + 4% cess 4,840 = 1,25,840, rebate inapplicable', () => {
    expect(annualTax('1605000.00')).toEqual({
      tax: '121000.00',
      rebate: '0.00',
      marginalRelief: '0.00',
      cess: '4840.00',
      total: '125840.00',
    });
  });

  it('marginal relief just above ₹12 lakh: 12,05,000 pays exactly the excess — 5,000.00', () => {
    // tax = 20,000 + 40,000 + 750 = 60,750; + 4% cess = 63,180; the excess
    // over 12L is 5,000 — relief caps the payable there.
    expect(annualTax('1205000.00')).toMatchObject({
      tax: '60750.00',
      cess: '2430.00',
      marginalRelief: '58180.00',
      total: '5000.00',
    });
  });

  it('safely above the threshold the relief is zero: 13,00,000 pays 78,000.00', () => {
    expect(annualTax('1300000.00').total).toBe('78000.00');
  });

  it.each([
    ['400000.00', '0.00'],
    ['800000.00', '0.00'],
    ['1600000.00', '124800.00'],
    ['2400000.00', '312000.00'],
  ])('the slab boundary %s lands on %s exactly', (income, total) => {
    expect(annualTax(income).total).toBe(total);
  });

  it('the top slab takes 30% beyond ₹24 lakh', () => {
    // 3,00,000 below 24L + 60,000 × 30% = 18,000 → 3,18,000 + 4% cess 12,720.
    expect(annualTax('2460000.00').total).toBe('330720.00');
  });
});

describe('statutory — TDS spread', () => {
  it('fixture H: 1,25,840 ÷ 6 remaining months = 20,973.33/month', () => {
    expect(tdsPerMonth('125840.00', 6)).toBe('20973.33');
  });

  it('a true .xx5 boundary rounds half-up once', () => {
    // 100.01 ÷ 2 = 50.005 — the exact half-paise the epsilon term rescues.
    expect(tdsPerMonth('100.01', 2)).toBe('50.01');
  });

  it('an exact-half quotient rounds up deterministically', () => {
    expect(tdsPerMonth('125841.00', 6)).toBe('20973.50');
  });

  it('one remaining month carries the full remainder', () => {
    expect(tdsPerMonth('125840.00', 1)).toBe('125840.00');
  });

  it('refuses a non-positive or fractional month count', () => {
    expect(() => tdsPerMonth('100000.00', 0)).toThrow();
    expect(() => tdsPerMonth('100000.00', 1.5)).toThrow();
  });
});

describe('statutory — the config view matches the estimator', () => {
  it('exposes the FY 2026-27 constants the estimator uses', () => {
    const view = tdsConfigView();
    expect(view).toMatchObject({
      taxYear: 'FY 2026-27',
      regime: 'new',
      standardDeduction: '75000.00',
      cessRatePercent: 4,
      rebate: {
        section: 's.157',
        threshold: 1200000,
        residentOnly: true,
      },
    });
    expect(view.slabs).toEqual([
      { upto: 400000, ratePercent: 0 },
      { upto: 800000, ratePercent: 5 },
      { upto: 1200000, ratePercent: 10 },
      { upto: 1600000, ratePercent: 15 },
      { upto: 2000000, ratePercent: 20 },
      { upto: 2400000, ratePercent: 25 },
      { upto: null, ratePercent: 30 },
    ]);
    expect(FY_2026_27_SLABS).toHaveLength(7);
  });
});
