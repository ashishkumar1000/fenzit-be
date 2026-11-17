import { moneyText, roundMoney } from './formula';
import { isMonthKey } from './effective-dating';

/**
 * The pure statutory computation module (CAP-6): PF on earned basic and the
 * new-regime FY 2026-27 TDS estimator. NO I/O — the run engine resolves the
 * inputs (earned basic, covered decisions, spread windows) and calls these.
 *
 * The statutory constants live in CODE, not admin-editable tables: the wage
 * ceiling and the slabs are statute, not policy, and an editable surface
 * would be a compliance foot-gun. A new notification is a dated row here and
 * the fixture's own numbers pin them as tests.
 *
 * Money figures are exact-decimal TEXT ("20000.00"); every emitted figure is
 * rounded ONCE (half-up, formula.ts roundMoney).
 */

// -- PF (EPF Act s.6; basis s.2(b)(ii) = basic wages payable for the period)

export const PF_RATE = 0.12;

/**
 * The wage ceiling, effective-dated (statutory-verification.md §PF wage
 * ceiling): ₹15,000 since 2014-09-01, ₹25,000 from 2026-09-17
 * (S.O. 5109(E)). A run resolves the row effective for its run month's
 * FIRST day — a 2026-09 run resolves ₹15,000 even though the revision is
 * dated 2026-09-16/17 inside that month.
 */
const PF_CEILING_ROWS: ReadonlyArray<{ from: string; amount: string }> = [
  { from: '2014-09-01', amount: '15000.00' },
  { from: '2026-09-17', amount: '25000.00' },
];

/**
 * The PF wage ceiling that governs a run month (month-start resolution).
 * The month MUST be a real YYYY-MM key — a malformed one would silently
 * resolve the wrong ceiling, so it refuses loudly.
 */
export function pfWageCeiling(month: string): string {
  if (!isMonthKey(month)) {
    throw new Error('pfWageCeiling needs a real month written as YYYY-MM');
  }
  const firstDay = `${month}-01`;
  let resolved = PF_CEILING_ROWS[0];
  for (const row of PF_CEILING_ROWS) {
    if (row.from <= firstDay) resolved = row;
  }
  return resolved.amount;
}

/**
 * The employee PF deduction: 12% × min(earned basic, ceiling) — the ceiling
 * binds BEFORE the rate, never after. The employer share is recorded, never
 * deducted, and equals the employee figure (v1: no EPS split).
 */
export function pfDeduction(
  earnedBasic: string,
  ceiling: string,
): { employee: string; employer: string } {
  const basis = Math.min(Number(earnedBasic), Number(ceiling));
  // A non-numeric text would silently emit "NaN" and a negative one has no
  // statutory meaning — statutory money must never leave this module
  // without refusing loudly first.
  if (!Number.isFinite(basis) || basis < 0) {
    throw new Error('pfDeduction needs non-negative numeric money text');
  }
  const employee = moneyText(PF_RATE * basis);
  return { employee, employer: employee };
}

// -- TDS (Income-tax Act, 2025 — new regime, FY 2026-27)

export interface TdsSlab {
  /** Exclusive upper bound of the slab in rupees (Infinity = top slab). */
  upto: number;
  /** The slab's rate as a fraction of the amount inside it. */
  rate: number;
}

/**
 * New-regime slabs, unchanged by Budget 2026 (statutory-verification.md
 * §TDS): 0–4L nil · 4–8L 5% · 8–12L 10% · 12–16L 15% · 16–20L 20% ·
 * 20–24L 25% · >24L 30%.
 */
export const FY_2026_27_SLABS: readonly TdsSlab[] = [
  { upto: 400000, rate: 0 },
  { upto: 800000, rate: 0.05 },
  { upto: 1200000, rate: 0.1 },
  { upto: 1600000, rate: 0.15 },
  { upto: 2000000, rate: 0.2 },
  { upto: 2400000, rate: 0.25 },
  { upto: Number.POSITIVE_INFINITY, rate: 0.3 },
];

/** Annual standard deduction for the new regime (₹75,000, unchanged). */
export const FY_2026_27_STANDARD_DEDUCTION = '75000.00';

/** s.157 rebate: resident-only, 100% of tax on income up to ₹12 lakh. */
export const FY_2026_27_REBATE_THRESHOLD = 1200000;
export const FY_2026_27_CESS_RATE = 0.04;

/**
 * The FY 2026-27 statutory TDS config, as the read endpoint answers it —
 * the same constants the estimator uses, so the web UI renders what runs.
 */
export function tdsConfigView() {
  return {
    taxYear: 'FY 2026-27',
    regime: 'new',
    standardDeduction: FY_2026_27_STANDARD_DEDUCTION,
    slabs: FY_2026_27_SLABS.map((slab) => ({
      upto: slab.upto === Number.POSITIVE_INFINITY ? null : slab.upto,
      ratePercent: roundMoney(slab.rate * 100),
    })),
    rebate: {
      section: 's.157',
      threshold: FY_2026_27_REBATE_THRESHOLD,
      residentOnly: true,
      description:
        'No tax on income up to ₹12 lakh; above it, marginal relief caps the payable tax at the amount exceeding ₹12 lakh',
    },
    cessRatePercent: roundMoney(FY_2026_27_CESS_RATE * 100),
  };
}

/**
 * The annual new-regime tax on a taxable salary income: the slab walk, the
 * resident-only s.157 rebate (income up to ₹12 lakh pays nothing), and
 * marginal relief just above the threshold (tax + cess can never exceed the
 * amount by which the income exceeds ₹12 lakh). 4% health & education cess.
 */
export function annualTax(taxableAnnual: string): {
  tax: string;
  rebate: string;
  marginalRelief: string;
  cess: string;
  total: string;
} {
  const income = Number(taxableAnnual);
  if (!Number.isFinite(income) || income < 0) {
    throw new Error('annualTax needs non-negative numeric money text');
  }
  let lower = 0;
  let tax = 0;
  for (const slab of FY_2026_27_SLABS) {
    if (income > lower) {
      tax += (Math.min(income, slab.upto) - lower) * slab.rate;
    }
    lower = slab.upto;
  }

  // Rebate first, THEN assert any number (the fixture's rule): income up to
  // ₹12 lakh pays no tax at all (the rebate wipes the slab tax; the cess is
  // computed on the post-rebate amount); just above the threshold, marginal
  // relief caps the payable total at the excess over ₹12 lakh.
  // SHORTCUT: the resident-only condition of s.157 is not evaluated — every
  // employee in scope is assumed resident (Indian SME payroll; the new
  // regime is the default without a declaration). A non-resident input
  // would be over-rebated; revisit if residency is ever tracked.
  const rebate = income <= FY_2026_27_REBATE_THRESHOLD ? tax : 0;
  const cess = roundMoney((tax - rebate) * FY_2026_27_CESS_RATE);
  const grossTotal = roundMoney(tax - rebate + cess);
  const excess = Math.max(0, income - FY_2026_27_REBATE_THRESHOLD);
  const marginalRelief =
    income > FY_2026_27_REBATE_THRESHOLD
      ? roundMoney(Math.max(0, grossTotal - excess))
      : 0;
  const total = moneyText(grossTotal - marginalRelief);
  return {
    tax: moneyText(tax),
    rebate: moneyText(rebate),
    marginalRelief: moneyText(marginalRelief),
    cess: moneyText(cess),
    total,
  };
}

/**
 * The monthly TDS share: the annual estimate divided over the remaining FY
 * months INCLUDING the run month, rounded half-up. The re-spread (annual
 * estimate − TDS already deducted) and the leaver's full-remainder rule are
 * the run engine's bookkeeping; they call this with the right inputs.
 */
export function tdsPerMonth(totalAnnual: string, months: number): string {
  if (!Number.isInteger(months) || months < 1) {
    throw new Error('tdsPerMonth needs at least one month');
  }
  const total = Number(totalAnnual);
  if (!Number.isFinite(total) || total < 0) {
    throw new Error('tdsPerMonth needs non-negative numeric money text');
  }
  return moneyText(total / months);
}
