/**
 * The payable-window arithmetic (SPEC §Run arithmetic) — pure, no I/O.
 *
 * The canonical fixture's asserted day-counts pin this shape (verified
 * against every row; see plan-23-6 §The window decision):
 *  - PAYABLE days = the employment window ∩ the run month itself, capped at
 *    the divisor keeping the EARLIEST dates (C: Oct 20–31 = 12; C2: Oct 1–10
 *    = 10; base A: 31 → 26; calendar: 31; November: 30 → 26).
 *  - LOP attribution follows date OWNERSHIP (fixed by the OWNING month's
 *    resolved cut-off, never the consuming run's): month M's run owns M's
 *    dates ≤ cutoff(M) plus M−1's post-cut-off dates. The November row's
 *    Oct-27 prior-period leave LOPs in November (1.0) even though the date
 *    is not payable there — attribution is by ownership, not by the payable
 *    set. The one fixture row this rule answers differently is September's
 *    "payable 25" text (the rule gives 26); the row's asserted number (PF
 *    1,800.00, ceiling binding) is identical either way.
 */

export interface EmploymentDates {
  joinDate: string | null;
  exitDate: string | null;
}

/** The last day of month `YYYY-MM`, as YYYY-MM-DD. */
export function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** The first day of the month AFTER `YYYY-MM`. */
export function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + 1, 1)).toISOString().slice(0, 7);
}

export function prevMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 - 1, 1)).toISOString().slice(0, 7);
}

/** Every date string in [from, to] inclusive, ascending. */
export function datesIn(from: string, to: string): string[] {
  const out: string[] = [];
  const end = new Date(`${to}T00:00:00Z`).getTime();
  for (
    let t = new Date(`${from}T00:00:00Z`).getTime();
    t <= end;
    t += 86400000
  ) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

const monthStartOf = (date: string): string => date.slice(0, 7);

/**
 * A date belongs to month M's run for LOP attribution (as a prior-period day)
 * when it falls in M−1 and is after M−1's resolved cut-off; it belongs to its
 * own month's run when it is on/before that month's cut-off.
 */
export function ownedByRun(
  date: string,
  month: string,
  cutoffOf: (m: string) => number,
): boolean {
  const own = monthStartOf(date);
  if (own === month) return Number(date.slice(8, 10)) <= cutoffOf(month);
  if (own === prevMonth(month)) {
    return Number(date.slice(8, 10)) > cutoffOf(prevMonth(month));
  }
  return false;
}

/** The payable window for month M: the employment window ∩ the month,
 * ascending. Empty when the employee has no employment inside the month. */
export function payableWindow(
  employment: EmploymentDates,
  month: string,
): string[] {
  if (!employment.joinDate) return [];
  const monthStart = `${month}-01`;
  const start =
    employment.joinDate > monthStart ? employment.joinDate : monthStart;
  const end = employment.exitDate
    ? employment.exitDate < monthEnd(month)
      ? employment.exitDate
      : monthEnd(month)
    : monthEnd(month);
  if (start > end) return [];
  return datesIn(start, end);
}

/**
 * The dates month M's run OWNS for LOP/day-status attribution: month M's
 * dates up to its resolved cut-off, plus M−1's post-cut-off dates — always
 * intersected with the employment window, never capped (the November row's
 * Oct-27 prior-period leave LOPs here).
 */
export function lopWindow(
  employment: EmploymentDates,
  month: string,
  cutoffOf: (m: string) => number,
): string[] {
  if (!employment.joinDate) return [];
  const monthStart = `${month}-01`;
  // The span reaches back into the prior month so its post-cut-off dates
  // (owned by this run) are inside it; ownedByRun drops the rest.
  const join = employment.joinDate;
  if (!join) return [];
  const spanStart = join < monthStart ? join : monthStart;
  const end = employment.exitDate
    ? employment.exitDate < monthEnd(month)
      ? employment.exitDate
      : monthEnd(month)
    : monthEnd(month);
  if (spanStart > end) return [];
  // The employment bounds filter the owned set: a pre-join (or post-exit)
  // date is never this employee's LOP, even when the month owns it.
  return datesIn(spanStart, end).filter(
    (d) =>
      d >= join &&
      (!employment.exitDate || d <= employment.exitDate) &&
      ownedByRun(d, month, cutoffOf),
  );
}

/** The divisor cap keeps the EARLIEST dates; the discarded tail loses pay
 * and LOP alike (within the payable month). */
export function capPayable(window: string[], divisor: number): string[] {
  return window.slice(0, divisor);
}
