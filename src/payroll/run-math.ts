/**
 * The run's money arithmetic (SPEC §Run arithmetic) — pure, no I/O. Every
 * emitted figure is rounded ONCE (half-up, formula.ts); intermediates stay
 * unrounded floats.
 */
import { moneyText, roundMoney } from './formula';
import { annualTax, tdsPerMonth } from './statutory';

/**
 * Earnings for the period: the evaluated structure amount ÷ divisor ×
 * (payable − LOP) — the daily wage stays unrounded, half-up rounding lands
 * once on the line. A full month with no LOP yields exactly the structure
 * amount under every divisor.
 */
export function earnings(
  structureAmount: number,
  divisor: number,
  paidDays: number,
): string {
  return moneyText((structureAmount / divisor) * paidDays);
}

/** One earning line: the component's evaluated amount prorated the same way. */
export function earnedLine(
  componentAmount: number,
  divisor: number,
  paidDays: number,
): string {
  return moneyText((componentAmount / divisor) * paidDays);
}

export interface DeductionLine {
  source: string;
  amount: number;
}

export interface CapResult {
  lines: DeductionLine[];
  totalDeductions: string;
  netWages: string;
  /** The unabsorbed excess to raise as a recovery line ('0.00' when none). */
  excess: string;
}

/**
 * The flat 50% cap: total deductions may not exceed 50% of the post-LOP
 * pre-deduction gross. A breach clamps the lines PROPORTIONALLY (half-up per
 * line, the residual pinned on the largest line so the total lands exactly)
 * and raises the excess as a recovery line for the next run.
 */
export function capClamp(
  lines: DeductionLine[],
  postLopGross: number,
): CapResult {
  const cap = roundMoney(0.5 * postLopGross);
  const total = roundMoney(lines.reduce((sum, l) => sum + l.amount, 0));
  if (total <= cap) {
    return {
      lines,
      totalDeductions: moneyText(total),
      netWages: moneyText(roundMoney(postLopGross - total)),
      excess: '0.00',
    };
  }
  const scale = cap / total;
  const scaled = lines
    .map((l) => ({ source: l.source, amount: roundMoney(l.amount * scale) }))
    .sort((a, b) => b.amount - a.amount);
  const drift = roundMoney(cap - scaled.reduce((sum, l) => sum + l.amount, 0));
  if (drift !== 0 && scaled.length > 0) {
    scaled[0].amount = roundMoney(scaled[0].amount + drift);
  }
  const clampedTotal = roundMoney(scaled.reduce((sum, l) => sum + l.amount, 0));
  return {
    lines: scaled,
    totalDeductions: moneyText(clampedTotal),
    netWages: moneyText(roundMoney(postLopGross - clampedTotal)),
    excess: moneyText(roundMoney(total - cap)),
  };
}

/**
 * The TDS projection: the CURRENT monthly structure × the months of
 * employment in the FY (never the post-LOP period gross), less the standard
 * deduction, less the TDS already deducted in the FY's prior periods,
 * spread over the remaining FY months INCLUDING the run month. A leaver's
 * final run deducts the full remaining estimate naturally (their employment
 * months end at the exit month).
 */
export function tdsProjection(inputs: {
  monthlyStructure: number;
  monthsEmployedInFy: number;
  remainingFyMonths: number;
  priorFyTds: number;
}): string {
  const annual = inputs.monthlyStructure * inputs.monthsEmployedInFy;
  const taxable = annual - 75000;
  const assessed = taxable > 0 ? annualTax(taxable.toFixed(2)).total : '0.00';
  const remainingTotal = Math.max(0, Number(assessed) - inputs.priorFyTds);
  if (remainingTotal === 0) return '0.00';
  return tdsPerMonth(remainingTotal.toFixed(2), inputs.remainingFyMonths);
}

/** Months of employment inside FY 2026-27 (April 2026 – March 2027): the
 * span from the later of (FY start, join month) to the earlier of (FY end,
 * exit month) — future employment months count (the projection is annual). */
export function monthsEmployedInFy(
  joinDate: string | null,
  exitDate: string | null,
): number {
  const FY_START = '2026-04';
  const FY_END = '2027-03';
  const begin =
    joinDate && joinDate.slice(0, 7) > FY_START
      ? joinDate.slice(0, 7)
      : FY_START;
  const end =
    exitDate && exitDate.slice(0, 7) < FY_END ? exitDate.slice(0, 7) : FY_END;
  if (begin > end) return 0;
  const [by, bm] = begin.split('-').map(Number);
  const [ey, em] = end.split('-').map(Number);
  return (ey - by) * 12 + (em - bm) + 1;
}
