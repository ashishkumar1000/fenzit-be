import { HttpException, HttpStatus } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ErrorCode } from '../common/enums/error-code.enum';
import { payrollRunAdvisoryKey } from '../common/pg/advisory-keys';

/**
 * The payroll-lock date gate (23-7), attendance-local: once a month is
 * locked, its run-owned attendance dates are final and an edit of one is
 * refused with 409 PAYROLL_MONTH_LOCKED.
 *
 * WHICH dates a lock freezes follows the run engine's ownership rule, not
 * the calendar month alone: month M's run owns M's dates up to M's resolved
 * cut-off, and M−1's post-cut-off dates (they grade into M's payslips as
 * prior-period days). So a date is frozen when the month that OWNS it is
 * locked:
 *  - day ≤ cutoff(own month): frozen by the own month's lock;
 *  - day > cutoff(own month): owned by the successor month's run — editable
 *    until the successor locks.
 *
 * Plain table reads only — no import from payroll/ internals (the same seam
 * every other module keeps), and the default cut-off mirrors the payroll
 * calendar's house default here rather than reaching across.
 *
 * The range form (assertPayrollDatesEditable, 23-7 follow-up) serves the
 * multi-date leave writes: a request whose dates span months (or sit past a
 * cut-off) is refused WHOLE when any one of its dates is frozen — splitting
 * a leave request around a lock is not a thing the writer asked for. The
 * probe form (hasFrozenPayrollDate) serves the one path that must never
 * throw: the check-in's leave auto-cancel runs inside the check-in
 * transaction, so on a frozen date it skips the cancel instead of failing
 * the check-in.
 */

/** The house default when no dated calendar row governs the month. */
const DEFAULT_CUTOFF_DAY = 25;

function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

function lockedError(message: string): HttpException {
  return new HttpException(
    { error_code: ErrorCode.PAYROLL_MONTH_LOCKED, message },
    HttpStatus.CONFLICT,
  );
}

type CutoffOf = (month: string) => number;

/**
 * One calendar read for every month the caller might need: rows effective at
 * or before `latestMonth`'s first day, resolved in order, defaulting to 25.
 * effective_from comes back ::text — node-pg would hand a raw `date` over as
 * a JS Date, and the month-start compare below is a string compare (the
 * house idiom).
 */
async function readCutoffs(
  tx: PoolClient,
  tenantId: string,
  latestMonth: string,
): Promise<CutoffOf> {
  const calRes = await tx.query<{
    effective_from: string | Date;
    cutoff_day: number;
  }>(
    `select effective_from::text as effective_from, cutoff_day
       from public.payroll_calendar
      where tenant_id = $1::uuid and effective_from <= $2::date
      order by effective_from asc`,
    [tenantId, `${latestMonth}-01`],
  );
  return (month: string): number => {
    let cutoff = DEFAULT_CUTOFF_DAY;
    for (const row of calRes.rows) {
      // Belt-and-braces: the cast above returns text, but a driver upgrade
      // or a future query edit must not silently re-arm the Date compare.
      const effectiveFrom =
        row.effective_from instanceof Date
          ? row.effective_from.toISOString().slice(0, 10)
          : row.effective_from;
      if (effectiveFrom <= `${month}-01`) cutoff = row.cutoff_day;
    }
    return cutoff;
  };
}

/**
 * The one resolution body behind all three surfaces: which (if any) of
 * `dates` is owned by a locked payroll month. Answers with the EARLIEST
 * frozen date and its ownership facts, or null when every date is editable.
 *
 * Serialization: after resolving the OWNING months, the gate takes a shared
 * xact advisory lock on each owner's payroll-run key BEFORE reading the lock
 * rows — the lock service and the run engine take the same key exclusively,
 * so no lock insert nor run write can land between this read and the
 * caller's commit (the shared lock holds to COMMIT). Owners arrive in a
 * single `any()` read; shared locks never conflict with each other, so no
 * cross-caller cycle is possible.
 *
 * Runs inside the caller's transaction. Empty input resolves to an empty map.
 */
async function frozenFacts(
  tx: PoolClient,
  tenantId: string,
  dates: string[],
): Promise<
  Map<
    string,
    { owner: string; own: string; cutoff: number; ownMonthOwns: boolean }
  >
> {
  const frozen = new Map<
    string,
    { owner: string; own: string; cutoff: number; ownMonthOwns: boolean }
  >();
  if (dates.length === 0) return frozen;

  // Candidate owners: each date's own month and its successor (a post-
  // cut-off date belongs to the successor).
  let latestSuccessor = dates[0].slice(0, 7);
  for (const d of dates) {
    const successor = nextMonth(d.slice(0, 7));
    if (successor > latestSuccessor) latestSuccessor = successor;
  }
  const cutoffOf = await readCutoffs(tx, tenantId, latestSuccessor);

  const factsOf = (d: string) => {
    const own = d.slice(0, 7);
    const cutoff = cutoffOf(own);
    const ownMonthOwns = Number(d.slice(8, 10)) <= cutoff;
    return {
      own,
      cutoff,
      ownMonthOwns,
      owner: ownMonthOwns ? own : nextMonth(own),
    };
  };

  const owners = new Set<string>();
  for (const d of dates) owners.add(factsOf(d).owner);

  // Serialize against the month locks (and the owning months' run writes)
  // BEFORE reading the lock rows: the shared locks hold to COMMIT and the
  // lock takes the same keys exclusively for its decide+insert, so this
  // read cannot go stale before the caller commits.
  for (const owner of owners) {
    await tx.query(
      `select pg_advisory_xact_lock_shared(hashtextextended($1::text, 0))`,
      [payrollRunAdvisoryKey(tenantId, owner)],
    );
  }
  const lockRes = await tx.query<{ month: string }>(
    `select month from public.payroll_month_locks
     where tenant_id = $1::uuid and month = any($2::text[])`,
    [tenantId, [...owners]],
  );
  if (lockRes.rows.length === 0) return frozen;
  const locked = new Set(lockRes.rows.map((r) => r.month));

  for (const d of dates) {
    const f = factsOf(d);
    if (locked.has(f.owner)) frozen.set(d, f);
  }
  return frozen;
}

/**
 * 409 when `workDate` is owned by a locked payroll month; otherwise resolve.
 * The corrections surface (put + delete) calls this single-date form.
 */
export function assertPayrollDateEditable(
  tx: PoolClient,
  tenantId: string,
  workDate: string,
): Promise<void> {
  return assertPayrollDatesEditable(tx, tenantId, [workDate], 'corrected');
}

/**
 * 409 when ANY date in `dates` is owned by a locked payroll month. The leave
 * write paths call this range form — a request is applied/approved whole or
 * not at all. The refusal names the EARLIEST frozen date.
 */
export function assertPayrollDatesEditable(
  tx: PoolClient,
  tenantId: string,
  dates: string[],
  noun = 'changed',
): Promise<void> {
  return (async () => {
    const frozen = await frozenFacts(tx, tenantId, dates);
    if (frozen.size === 0) return;
    const earliest = [...frozen.keys()].sort()[0];
    const f = frozen.get(earliest)!;
    if (f.ownMonthOwns) {
      throw lockedError(
        `${f.owner} is locked for payroll — ${earliest} falls on or before its day-${f.cutoff} cut-off, so it can no longer be ${noun}`,
      );
    }
    throw lockedError(
      `${f.owner} is locked for payroll and owns ${earliest} (after ${f.own}'s day-${f.cutoff} cut-off) — the date can no longer be ${noun}`,
    );
  })();
}

/**
 * Non-throwing probe: does ANY of `dates` belong to a locked payroll month?
 * It never answers the business 409 — the check-in's leave auto-cancel
 * skips the cancel on a frozen date instead of failing the check-in. (Real
 * DB failures still reject; the caller fails loud on those, as it should.)
 */
export function hasFrozenPayrollDate(
  tx: PoolClient,
  tenantId: string,
  dates: string[],
): Promise<boolean> {
  return frozenFacts(tx, tenantId, dates).then((f) => f.size > 0);
}

/**
 * The FULL frozen subset of `dates` — for callers that must carve a write
 * around the lock rather than refuse it wholesale: the disable sweep
 * cancels an employee's approved days from today onward, and a frozen date
 * among them is SKIPPED (logged) while the rest still cancel. Same
 * non-throwing contract as the probe.
 */
export function frozenPayrollDates(
  tx: PoolClient,
  tenantId: string,
  dates: string[],
): Promise<Set<string>> {
  return frozenFacts(tx, tenantId, dates).then((f) => new Set(f.keys()));
}
