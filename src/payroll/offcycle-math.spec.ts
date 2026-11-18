import {
  OFFCYCLE_DEDUCTION_PREFIX,
  finalRunCap,
  isFinalRun,
  offCycleDeductionEntries,
  offCycleEarningEntries,
  offCycleEarningsTotal,
  pfBaseWithOffCycle,
  tdsAnnualWithOffCycle,
  type OffCycleLine,
} from './offcycle-math';
import { capClamp } from './run-math';

/**
 * The off-cycle run arithmetic (23-9): the flat earning join, the wage-tag
 * PF base join, the signed TDS annual join, the final-run owner rule, and
 * the final-run cap exemption with its absorbed-allocation and net-floor
 * boundaries. QA mindset — the boundaries are the spec here.
 */

const line = (overrides: Partial<OffCycleLine> = {}): OffCycleLine => ({
  id: 'line-1',
  membershipId: 'm-1',
  label: 'Festival bonus',
  amount: 5000,
  tag: 'bonus',
  status: 'staged',
  ...overrides,
});

describe('offcycle-math — the line joins', () => {
  it('positive lines join the earning break-up as FLAT entries, never prorated', () => {
    const entries = offCycleEarningEntries([
      line({ amount: 5000, label: 'Festival bonus' }),
      line({ id: 'l2', amount: 250.5, label: ' Arrear ' }),
    ]);
    expect(entries).toEqual([
      { name: 'Off-cycle: Festival bonus', amount: '5000.00' },
      { name: 'Off-cycle:  Arrear ', amount: '250.50' },
    ]);
  });

  it('negative lines never appear as earnings and never join the gross', () => {
    const entries = offCycleEarningEntries([line({ amount: -1200 })]);
    expect(entries).toEqual([]);
    expect(offCycleEarningsTotal([line({ amount: -1200 })])).toBe(0);
    expect(offCycleEarningsTotal([line({ amount: 5000 })])).toBe(5000);
  });

  it('negative lines join the capped deductions with the dedicated prefix and a positive amount', () => {
    const entries = offCycleDeductionEntries([
      line({ amount: -1200, label: 'Advance clawback' }),
    ]);
    expect(entries).toEqual([
      { source: `${OFFCYCLE_DEDUCTION_PREFIX}Advance clawback`, amount: 1200 },
    ]);
    expect(OFFCYCLE_DEDUCTION_PREFIX.startsWith('recovery:')).toBe(false);
  });

  it('the PF base join: wage-tagged positives join, bonus never does, negatives never do', () => {
    const lines = [
      line({ amount: 3000, tag: 'wage' }),
      line({ id: 'l2', amount: 5000, tag: 'bonus' }),
      line({ id: 'l3', amount: -1000, tag: 'wage' }),
    ];
    expect(pfBaseWithOffCycle(17307.69, lines)).toBe(20307.69);
    expect(
      pfBaseWithOffCycle(17307.69, [line({ amount: 5000, tag: 'bonus' })]),
    ).toBe(17307.69);
    expect(pfBaseWithOffCycle(0, [line({ amount: 3000, tag: 'wage' })])).toBe(
      3000,
    );
  });

  it('the TDS annual join takes the SIGNED sum (a recovery reduces the projection)', () => {
    expect(tdsAnnualWithOffCycle(336000, [line({ amount: 5000 })])).toBe(
      341000,
    );
    expect(tdsAnnualWithOffCycle(336000, [line({ amount: -5000 })])).toBe(
      331000,
    );
    expect(tdsAnnualWithOffCycle(336000, [])).toBe(336000);
  });
});

describe('offcycle-math — the final-run owner rule', () => {
  it('an exit in the run month makes THAT run final — every day of the exit month', () => {
    expect(isFinalRun('2026-10-25', '2026-10')).toBe(true);
    expect(isFinalRun('2026-10-27', '2026-10')).toBe(true);
    expect(isFinalRun('2026-10-25', '2026-11')).toBe(false);
    expect(isFinalRun('2026-10-27', '2026-11')).toBe(false);
  });

  it('the successor month never runs a leaver whose employment ended the month before — the empty payable window skips them, so finality belongs to the exit month (2026-11-18 review: the day-based LOP ownership must not govern which slip is final)', () => {
    // The old rule handed finality for an Oct-27 exit to November — but
    // November's run skips the leaver, leaving the TDS spread over months
    // they never work and recoveries unsettled.
    expect(isFinalRun('2026-10-27', '2026-10')).toBe(true);
    expect(isFinalRun('2026-10-27', '2026-11')).toBe(false);
  });

  it('no exit date is never a final run; an unrelated month never is either', () => {
    expect(isFinalRun(null, '2026-10')).toBe(false);
    expect(isFinalRun('2026-10-10', '2026-12')).toBe(false);
    expect(isFinalRun('2026-10-10', '2026-10')).toBe(true); // pre-cutoff exit: own month
  });
});

describe('offcycle-math — the final-run cap', () => {
  const pf = { source: 'pf_employee', amount: 2000 };
  const pt = { source: 'head:PT', amount: 200 };
  const tds = { source: 'tds', amount: 1000 };
  const recovery = (id: string, amount: number) => ({
    source: 'recovery:2026-09',
    amount,
    recoveryId: id,
  });

  it('a calm final run: everything deducts, net is the remainder, every row absorbs in full', () => {
    const r = finalRunCap({
      gross: 20000,
      governed: [pf, pt],
      exempt: [tds, recovery('r-1', 500)],
    });
    expect(r.netWages).toBe('16300.00');
    expect(r.totalDeductions).toBe('3700.00');
    expect(r.absorbedByRow.get('r-1')).toBe(500);
    expect(r.unabsorbableExcess).toBe('0.00');
  });

  it('the governed set still clamps at 50% of gross — and the excess is REPORTED, never raised', () => {
    const r = finalRunCap({
      gross: 20000,
      governed: [pf, pt, { source: 'head:insurance', amount: 9000 }],
      exempt: [recovery('r-1', 100)],
    });
    // cap = 10,000; governed total 11,200 → clamped to 10,000, excess 1,200.
    expect(r.unabsorbableExcess).toBe('1200.00');
    expect(r.totalDeductions).toBe('10100.00');
    expect(r.netWages).toBe('9900.00');
    expect(r.absorbedByRow.get('r-1')).toBe(100);
  });

  it('the floor: when exempt lines exceed the headroom, recoveries absorb in order and the balance stays outstanding', () => {
    const r = finalRunCap({
      gross: 5000,
      governed: [pf], // 2,000, under cap 2,500
      exempt: [recovery('r-1', 2000), recovery('r-2', 4000)],
    });
    // headroom = 5000 − 2000 = 3000 → r-1 absorbs 2000, r-2 absorbs 1000.
    expect(r.absorbedByRow.get('r-1')).toBe(2000);
    expect(r.absorbedByRow.get('r-2')).toBe(1000);
    expect(r.netWages).toBe('0.00');
    const r2Line = r.lines.find((l) => l.recoveryId === 'r-2');
    expect(r2Line?.amount).toBe(1000); // only the absorbed part sits on the slip
  });

  it('the boundary: deductions exactly = gross → net exactly zero, nothing lost', () => {
    const r = finalRunCap({
      gross: 3000,
      governed: [{ source: 'pf_employee', amount: 1000 }],
      exempt: [recovery('r-1', 2000)],
    });
    expect(r.netWages).toBe('0.00');
    expect(r.absorbedByRow.get('r-1')).toBe(2000);
  });

  it('one paise over the gross still floors at zero and keeps the balance outstanding', () => {
    const r = finalRunCap({
      gross: 3000,
      governed: [{ source: 'pf_employee', amount: 1000 }],
      exempt: [recovery('r-1', 2000.01)],
    });
    expect(r.netWages).toBe('0.00');
    expect(r.absorbedByRow.get('r-1')).toBe(2000);
  });

  it('TDS records IN FULL even when the net floors — it is a computed liability, not a balance', () => {
    const r = finalRunCap({
      gross: 3000,
      governed: [{ source: 'pf_employee', amount: 1000 }],
      exempt: [{ source: 'tds', amount: 5000 }, recovery('r-1', 1000)],
    });
    // TDS deducts in full (no headroom left for the recovery).
    expect(r.absorbedByRow.get('r-1')).toBe(0);
    expect(r.netWages).toBe('0.00');
    const tdsLine = r.lines.find((l) => l.source === 'tds');
    expect(tdsLine?.amount).toBe(5000);
  });

  it('zero gross: a leaver with no earnings absorbs nothing and owes nothing on the slip', () => {
    const r = finalRunCap({
      gross: 0,
      governed: [],
      exempt: [recovery('r-1', 500)],
    });
    expect(r.netWages).toBe('0.00');
    expect(r.absorbedByRow.get('r-1')).toBe(0);
    expect(r.lines).toEqual([]); // a ₹0.00 recovery row never prints
  });

  it('a row that absorbs nothing stays off the slip — the map still records its zero', () => {
    const r = finalRunCap({
      gross: 3000,
      governed: [{ source: 'pf_employee', amount: 1000 }],
      exempt: [{ source: 'tds', amount: 2000 }, recovery('r-1', 700)],
    });
    // headroom = 3000 − 1000 − 2000 = 0 → r-1 absorbs nothing.
    expect(r.absorbedByRow.get('r-1')).toBe(0);
    expect(
      r.lines.find((l) => l.source === 'recovery:2026-09'),
    ).toBeUndefined();
  });
});

describe('offcycle-math — the shipped clamp keeps recovery rows keyed', () => {
  it('capClamp preserves the recoveryId through the breach path (23-9: keyed decrements)', () => {
    const r = capClamp(
      [
        { source: 'pf_employee', amount: 2000, recoveryId: 'r-1' },
        { source: 'head:PT', amount: 8000 },
      ],
      5000, // cap 2500 → clamped proportionally
    );
    const keyed = r.lines.find((l) => l.recoveryId === 'r-1');
    expect(keyed).toBeDefined();
    expect(keyed?.amount).toBeLessThan(2000);
  });
});
