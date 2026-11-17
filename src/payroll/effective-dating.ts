/**
 * Month-start resolution for effective-dated payroll config rows (SPEC, Run
 * arithmetic): the row in effect for a run month is the latest row whose
 * effective_from is on or before that month's first day (tenant tz). A
 * mid-month-dated change is therefore first used by the NEXT month's run, an
 * unlocked re-run resolves its own month (never the newest save), and locked
 * months keep their run-time snapshots. Pure — no I/O.
 */

/** The one field every effective-dated payroll config row carries. */
export interface EffectiveDatedRow {
  effectiveFrom: string; // 'YYYY-MM-DD'
}

/** A run-month key: 'YYYY-MM' with a real month number. */
export function isMonthKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = /^(\d{4})-(\d{2})$/.exec(value);
  if (!m) return false;
  const month = Number(m[2]);
  return month >= 1 && month <= 12;
}

export function monthFirstDay(month: string): string {
  return `${month}-01`;
}

/**
 * The effective row for the run month: the latest effectiveFrom <= the
 * month's first day. Undefined when none qualifies (a run month before the
 * first effective date — the caller decides what that means; the run engine
 * skips, config endpoints never guess). Ties cannot occur (unique
 * effective_from per owner), but the >= comparison keeps the answer
 * deterministic for unordered input regardless.
 */
export function resolveEffective<T extends EffectiveDatedRow>(
  rows: T[],
  month: string,
): T | undefined {
  const first = monthFirstDay(month);
  let best: T | undefined;
  for (const row of rows) {
    if (row.effectiveFrom > first) continue;
    if (best === undefined || row.effectiveFrom >= best.effectiveFrom) {
      best = row;
    }
  }
  return best;
}
