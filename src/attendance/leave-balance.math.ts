import { roundMoney } from '../payroll/formula';
import type { SpanDayFacts } from './leave.repository';

/**
 * The accrual arithmetic for derived leave balances (23-13). Pure over
 * ISO strings and pre-read maps — the service reads, this decides. The
 * financial year is April–March; a FY is named by its starting April
 * year (FY 2026 = 2026-04-01..2027-03-31).
 *
 * The derivation contract the caller upholds:
 *   balance(Y) = credits(Y) + accrued(Y, asOf) + carryForward(Y) - consumed(Y)
 * where carryForward(Y) is the PRIOR FY's unused balance — credits + a
 * FULL-FY accrual + its own carry-forward - consumed — only when that
 * prior FY completed before asOf, floored at 0 so a negative balance
 * never carries as debt. Every sum is rounded to 2dp half-up (the house
 * roundMoney) and the sufficiency comparison runs on rounded values.
 */

/** One catalog type as the accrual math sees it (the service maps the
 *  DB row onto this). accrualMode null = an unmatched legacy remnant,
 *  which never joins any derivation. */
export interface AccrualTypeConfig {
  id: string;
  code: string | null;
  name: string;
  accrualMode: 'monthly' | 'annual' | 'none' | null;
  accrualDays: number;
  carryForward: boolean;
  allowOverBalance: boolean;
  enabled: boolean;
}

/** One balance row as every read surface answers it. */
export interface DerivedBalance {
  credits: number;
  accrued: number;
  carryForward: number;
  consumed: number;
  remaining: number;
}

/** The FY a date falls in, named by its starting April year. */
export function fyOf(date: string): number {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return month >= 4 ? year : year - 1;
}

/** The FY's first and last day. */
export function fyWindow(startYear: number): { start: string; end: string } {
  return {
    start: `${startYear}-04-01`,
    end: `${startYear + 1}-03-31`,
  };
}

/** Inclusive month count between 'YYYY-MM' months (0 backwards). Months
 *  are compared as strings — lexicographic order IS calendar order, so
 *  no date objects anywhere. */
export function monthsAccruedBetween(
  fromMonth: string,
  toMonth: string,
): number {
  const index = (month: string): number =>
    Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
  const diff = index(toMonth) - index(fromMonth);
  return diff < 0 ? 0 : diff + 1;
}

/**
 * The monthly accrual as of a date: rate × the months from max(join
 * month, FY start) through min(current month, FY end). The join month
 * counts in FULL (no day-level proration); a leaver's accrual stops at
 * the exit month once the exit date has arrived (exitDate <= asOf);
 * mid-FY joiners accrue from their join month; a date before the FY
 * (or an as-of before it) accrues nothing.
 */
export function accruedMonthly(
  rate: number,
  joinDate: string,
  fyStartYear: number,
  asOf: string,
  exitDate?: string | null,
): number {
  const window = fyWindow(fyStartYear);
  let from = joinDate.slice(0, 7);
  if (window.start.slice(0, 7) > from) from = window.start.slice(0, 7);
  let to = asOf.slice(0, 7);
  if (window.end.slice(0, 7) < to) to = window.end.slice(0, 7);
  if (exitDate && exitDate <= asOf && exitDate.slice(0, 7) < to) {
    to = exitDate.slice(0, 7);
  }
  return roundMoney(Math.max(0, rate * monthsAccruedBetween(from, to)));
}

/**
 * The annual fixed grant: credited in full for the FY from day one, no
 * pro-rating, untouched by the leaver clamp.
 */
export function accruedAnnual(days: number): number {
  return roundMoney(Math.max(0, days));
}

/** A day row's debit: full day 1, either half 0.5. Half-day requests are
 *  single-date-only (23-2 apply shape), so no multi-row half path exists. */
export function partWeight(part: string): number {
  return part === 'full_day' ? 1 : 0.5;
}

/**
 * The amount a completed FY hands forward: its unused balance floored at
 * 0 — an over-consumed year never carries debt into the next one.
 */
export function carryableUnused(unused: number): number {
  return Math.max(0, roundMoney(unused));
}

/** One active (pending/approved) day row, joined to its request's type
 *  and part. */
export interface DayDebitRow {
  leave_date: string;
  part: string;
  leave_type_id: string | null;
}

/** The consumed bucket's key: type id | FY (one map carries every type,
 *  built from one batched day-row read). */
export function consumedKey(typeId: string, fy: number): string {
  return `${typeId}|${fy}`;
}

/**
 * One type's slice of the shared consumed buckets, re-keyed by FY for
 * deriveTypeBalance.
 */
export function consumedForType(
  consumed: Map<string, number>,
  typeId: string,
): Map<number, number> {
  const byFy = new Map<number, number>();
  for (const [key, sum] of consumed) {
    if (key.startsWith(`${typeId}|`)) {
      byFy.set(Number(key.slice(typeId.length + 1)), sum);
    }
  }
  return byFy;
}

/**
 * The consumed debit per type per FY: every active day row of a
 * catalog type, weighted by its request's part, skipped on off days
 * (weekly off / holiday — the same facts the apply path read, so a
 * debit can never disagree with the request's own working-day count).
 * A date missing from the facts map counts as working — a debit may
 * never be silently dropped (the facts read covers every date fed in;
 * this is the conservative failure mode).
 */
export function consumedByTypeFy(
  rows: DayDebitRow[],
  facts: Map<string, SpanDayFacts>,
  typeIds: Set<string>,
): Map<string, number> {
  const bucketed = new Map<string, number>();
  for (const row of rows) {
    if (!row.leave_type_id || !typeIds.has(row.leave_type_id)) continue;
    // A date missing from the facts map counts as working — a debit may
    // never be silently dropped (the facts read covers every date fed in;
    // this is the conservative failure mode).
    const dayFacts = facts.get(row.leave_date);
    if (dayFacts && !dayFacts.isWorkingDay) continue;
    const key = consumedKey(row.leave_type_id, fyOf(row.leave_date));
    bucketed.set(key, (bucketed.get(key) ?? 0) + partWeight(row.part));
  }
  for (const [key, sum] of bucketed) bucketed.set(key, roundMoney(sum));
  return bucketed;
}

/**
 * Manual credits summed per type per FY (the numeric days arrive as
 * Postgres strings — one Number() at the boundary, one rounding at the
 * end; the user_id rides along for the batched capture's per-user split).
 */
export function creditsByTypeYear(
  rows: {
    leave_type_id: string;
    year: number;
    days: string | number;
    user_id?: string;
  }[],
): Map<string, Map<number, number>> {
  const byType = new Map<string, Map<number, number>>();
  for (const row of rows) {
    let byYear = byType.get(row.leave_type_id);
    if (!byYear) {
      byYear = new Map<number, number>();
      byType.set(row.leave_type_id, byYear);
    }
    byYear.set(row.year, (byYear.get(row.year) ?? 0) + Number(row.days));
  }
  for (const byYear of byType.values()) {
    for (const [year, sum] of byYear) byYear.set(year, roundMoney(sum));
  }
  return byType;
}

/**
 * The carry-forward chain: walks every completed FY from the join FY
 * through `throughFy - 1`, crediting a FULL-FY accrual (the leaver clamp
 * included) and handing the floored unused forward. Returns the amount
 * carried into `throughFy` AND each walked FY's raw unused balance — a
 * completed FY's honest balance (credits + full accrual + its own
 * carry-forward - consumed, unfloored: an over-consumed year is negative
 * and refuses more consumption).
 */
export function walkCarryForward(
  type: AccrualTypeConfig,
  joinDate: string,
  exitDate: string | null,
  throughFy: number,
  creditsForType: Map<number, number>,
  consumedForType: Map<number, number>,
): { carryForward: number; unusedByFy: Map<number, number> } {
  const unusedByFy = new Map<number, number>();
  const isMonthly = type.accrualMode === 'monthly';
  let carryForward = 0;
  for (let f = fyOf(joinDate); f < throughFy; f++) {
    const accruedFull = isMonthly
      ? accruedMonthly(type.accrualDays, joinDate, f, fyWindow(f).end, exitDate)
      : accruedAnnual(type.accrualDays);
    const unused = roundMoney(
      (creditsForType.get(f) ?? 0) +
        accruedFull +
        carryForward -
        (consumedForType.get(f) ?? 0),
    );
    unusedByFy.set(f, unused);
    carryForward = type.carryForward ? carryableUnused(unused) : 0;
  }
  return { carryForward, unusedByFy };
}

/**
 * One type's full derivation as of `asOf` (which names the CURRENT FY).
 * The carry-forward chain (walkCarryForward) hands the floored unused of
 * every completed FY forward; the current FY accrues as-of. Consumption
 * is never date-anchored here — future-dated pending days debit now.
 */
export function deriveTypeBalance(
  type: AccrualTypeConfig,
  joinDate: string,
  exitDate: string | null,
  asOf: string,
  creditsForType: Map<number, number>,
  consumedForType: Map<number, number>,
): DerivedBalance {
  const fy = fyOf(asOf);
  const { carryForward } = walkCarryForward(
    type,
    joinDate,
    exitDate,
    fy,
    creditsForType,
    consumedForType,
  );
  const isMonthly = type.accrualMode === 'monthly';
  const credits = roundMoney(creditsForType.get(fy) ?? 0);
  const accrued = isMonthly
    ? accruedMonthly(type.accrualDays, joinDate, fy, asOf, exitDate)
    : accruedAnnual(type.accrualDays);
  const consumed = roundMoney(consumedForType.get(fy) ?? 0);
  const remaining = roundMoney(credits + accrued + carryForward - consumed);
  return { credits, accrued, carryForward, consumed, remaining };
}

/**
 * The plain-English refusal, numbers included — the contract is that the
 * employee sees both figures ("you have 3.5 days left, this request
 * needs 4"). Rounded values only, trailing zeros trimmed by Number, and
 * the singular "day" when a figure is exactly 1.
 */
function dayWord(count: number): string {
  return count === 1 ? 'day' : 'days';
}

export function insufficientBalanceMessage(
  typeName: string,
  available: number,
  need: number,
): string {
  const left = Number(available);
  const needs = Number(need);
  return `Not enough ${typeName} balance — you have ${left} ${dayWord(left)} left and this request needs ${needs} ${dayWord(needs)}`;
}
