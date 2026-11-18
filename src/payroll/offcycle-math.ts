/**
 * The off-cycle line's run arithmetic (CAP-10, 23-9) — pure, no I/O. The
 * engine reads the month's lines and hands each member's slice to these
 * helpers; every emitted figure is rounded ONCE (half-up, formula.ts) and
 * intermediates stay unrounded.
 *
 * Shape of a line (payroll_off_cycle_lines): a positive amount is an EARNING
 * (a flat, never-prorated addition to the wage-period gross — it joins the
 * 50%-cap basis because the basis IS the earning-line set), and a negative
 * amount is a RECOVERY (a deduction; acknowledged server-side at staging).
 */
import { moneyText, roundMoney } from './formula';
import type { DeductionLine } from './run-math';

/** The payslip deduction-line prefix for a negative off-cycle line.
 * Deliberately NOT `recovery:` — the engine reconciles payroll_recovery_lines
 * rows by the recoveryId field, but the payslip's "others" grouping matches
 * prefixes, and a colliding prefix would also be read as a recovery row. */
export const OFFCYCLE_DEDUCTION_PREFIX = 'offcycle-recovery:';

export interface OffCycleLine {
  id: string;
  membershipId: string;
  label: string;
  /** Signed: positive = earning, negative = recovery. Never zero (DDL check). */
  amount: number;
  tag: 'wage' | 'bonus';
  status: 'staged' | 'applied';
}

/** The member's lines, in stable created_at order (the caller sorts). */
export function offCycleFor(
  lines: OffCycleLine[],
  membershipId: string,
): OffCycleLine[] {
  return lines.filter((l) => l.membershipId === membershipId);
}

/** Positive lines join the payslip's earning break-up as flat entries. */
export function offCycleEarningEntries(
  lines: OffCycleLine[],
): Array<{ name: string; amount: string }> {
  return lines
    .filter((l) => l.amount > 0)
    .map((l) => ({
      name: `Off-cycle: ${l.label}`,
      amount: moneyText(l.amount),
    }));
}

/** The flat amounts the member's positive lines add to the period gross. */
export function offCycleEarningsTotal(lines: OffCycleLine[]): number {
  return lines.reduce((sum, l) => (l.amount > 0 ? sum + l.amount : sum), 0);
}

/** Negative lines join the capped deduction set as recovery-style entries. */
export function offCycleDeductionEntries(
  lines: OffCycleLine[],
): DeductionLine[] {
  return lines
    .filter((l) => l.amount < 0)
    .map((l) => ({
      source: `${OFFCYCLE_DEDUCTION_PREFIX}${l.label}`,
      amount: Math.abs(l.amount),
    }));
}

/**
 * The PF base join (CAP-10): a wage-tagged earning is arrear/correction —
 * it joins the earned basic as PF wages for the period; bonus never does.
 * The ceiling binds downstream (pfDeduction), not here.
 */
export function pfBaseWithOffCycle(
  earnedBasic: number,
  lines: OffCycleLine[],
): number {
  return lines.reduce(
    (base, l) => (l.amount > 0 && l.tag === 'wage' ? base + l.amount : base),
    earnedBasic,
  );
}

/**
 * The TDS annual join (CAP-10): every line — signed — joins the projection's
 * annual income (the one monthly-amount lever the projection has), which the
 * spread then amortises over the remaining FY months.
 */
export function tdsAnnualWithOffCycle(
  structureAnnual: number,
  lines: OffCycleLine[],
): number {
  return structureAnnual + lines.reduce((sum, l) => sum + l.amount, 0);
}

function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/**
 * The leaver's final run: the LAST run whose owned dates reach the
 * employment window — the run month OWNS the exit date (its month when the
 * day is on or before that month's cut-off, else the successor's). Exit
 * exactly on the cut-off → the own month's final run.
 */
export function isFinalRun(
  exitDate: string | null,
  month: string,
  cutoffOf: (m: string) => number,
): boolean {
  if (!exitDate) return false;
  const own = exitDate.slice(0, 7);
  const cutoff = cutoffOf(own);
  const owner = Number(exitDate.slice(8, 10)) <= cutoff ? own : nextMonth(own);
  return owner === month;
}

export interface FinalRunCapInput {
  /** The post-LOP period gross INCLUDING off-cycle earnings. */
  gross: number;
  /** The cap-governed lines: pf_employee + head:* (never recovery-shaped). */
  governed: DeductionLine[];
  /** The exempt lines, deducted in full: TDS + every recovery-shaped line
   *  (payroll_recovery_rows via recoveryId, off-cycle negatives via source). */
  exempt: DeductionLine[];
}

export interface FinalRunCapResult {
  /** Every deduction line post-assignment, payslip-ready. */
  lines: DeductionLine[];
  totalDeductions: string;
  netWages: string;
  /** recoveryId → the amount that row actually absorbed. */
  absorbedByRow: Map<string, number>;
  /** The governed set's clamp excess — reported, never raised (a leaver's
   *  excess has no later run to absorb it). */
  unabsorbableExcess: string;
}

/**
 * The final run's deduction assignment (CAP-6/10 — "the leaver's TDS
 * remainder and unabsorbed recovery deduct on that run in full"):
 *
 *  1. The governed set clamps at the flat 50% cap as usual (its excess is
 *     REPORTED, never raised — no later run exists to absorb it).
 *  2. The exempt lines deduct in full, outside the cap.
 *  3. net = gross − all deductions, FLOORED at zero (capClamp never floors;
 *     exempt lines can push deductions past gross).
 *  4. When the floor bites, the recovery-shaped lines absorb what remains:
 *     each absorbs min(outstanding, headroom) in input order, the balance
 *     keeps its outstanding amount (reported as still-outstanding for a
 *     departed employee — collection moves to final settlement).
 *  5. TDS is a computed deduction, not a balance — it records in full and
 *     its over-gross part is simply the leaver's liability on the slip.
 */
export function finalRunCap(input: FinalRunCapInput): FinalRunCapResult {
  const cap = roundMoney(0.5 * input.gross);
  const governedTotal = roundMoney(
    input.governed.reduce((sum, l) => sum + l.amount, 0),
  );
  let governed = input.governed;
  let governedClamped = governedTotal;
  let unabsorbableExcess = 0;
  if (governedTotal > cap) {
    const scale = cap / governedTotal;
    governed = input.governed
      .map((l) => ({ source: l.source, amount: roundMoney(l.amount * scale) }))
      .sort((a, b) => b.amount - a.amount);
    const drift = roundMoney(
      cap - roundMoney(governed.reduce((s, l) => s + l.amount, 0)),
    );
    if (drift !== 0 && governed.length > 0) {
      governed[0].amount = roundMoney(governed[0].amount + drift);
    }
    governedClamped = roundMoney(
      governed.reduce((sum, l) => sum + l.amount, 0),
    );
    unabsorbableExcess = roundMoney(governedTotal - cap);
  }

  // Headroom for the recovery-shaped exempt lines: what the net could still
  // give up after the governed set and the TDS line.
  const tds = input.exempt.filter((l) => l.source === 'tds');
  const tdsTotal = roundMoney(tds.reduce((sum, l) => sum + l.amount, 0));
  const recoveries = input.exempt.filter((l) => l.source !== 'tds');
  let headroom = Math.max(
    0,
    roundMoney(input.gross - governedClamped - tdsTotal),
  );

  const absorbedByRow = new Map<string, number>();
  const recoveryLines: DeductionLine[] = recoveries.map((l) => {
    const absorbed = Math.min(l.amount, headroom);
    headroom = roundMoney(headroom - absorbed);
    if (l.recoveryId) absorbedByRow.set(l.recoveryId, absorbed);
    return {
      source: l.source,
      amount: roundMoney(absorbed),
      recoveryId: l.recoveryId,
    };
  });

  const lines = [
    ...governed,
    ...tds.map((l) => ({ source: l.source, amount: l.amount })),
    ...recoveryLines,
  ];
  const total = roundMoney(lines.reduce((sum, l) => sum + l.amount, 0));
  return {
    lines,
    totalDeductions: moneyText(total),
    netWages: moneyText(Math.max(0, roundMoney(input.gross - total))),
    absorbedByRow,
    unabsorbableExcess: moneyText(unabsorbableExcess),
  };
}
