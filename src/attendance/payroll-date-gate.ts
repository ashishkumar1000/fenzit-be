import { HttpException, HttpStatus } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ErrorCode } from '../common/enums/error-code.enum';
import { payrollRunAdvisoryKey } from '../common/pg/advisory-keys';

/**
 * The payroll-lock date gate (23-7), attendance-local: once a month is
 * locked, its run-owned attendance dates are final and a correction (put or
 * delete) on one is refused with 409 PAYROLL_MONTH_LOCKED.
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

/**
 * 409 when `workDate` is owned by a locked payroll month; otherwise resolve.
 * Runs inside the caller's transaction. Serialization: after resolving the
 * OWNING month, the gate takes a shared xact advisory lock on that month's
 * payroll-run key BEFORE reading the lock row — the lock service and the run
 * engine take the same key exclusively, so no lock insert nor run write can
 * land between this read and the correction's commit (the shared lock holds
 * to COMMIT). The in-tx placement buys read consistency; the advisory buys
 * the race-freedom.
 */
export async function assertPayrollDateEditable(
  tx: PoolClient,
  tenantId: string,
  workDate: string,
): Promise<void> {
  const ownMonth = workDate.slice(0, 7);
  const successor = nextMonth(ownMonth);

  // Both candidate months resolve against one read: the latest dated row at
  // or before each month's first day, else the default. effective_from comes
  // back ::text — node-pg would hand a raw `date` over as a JS Date, and the
  // month-start compare below is a string compare (the house idiom).
  const calRes = await tx.query<{
    effective_from: string | Date;
    cutoff_day: number;
  }>(
    `select effective_from::text as effective_from, cutoff_day
       from public.payroll_calendar
      where tenant_id = $1::uuid and effective_from <= $2::date
      order by effective_from asc`,
    [tenantId, `${successor}-01`],
  );
  const cutoffOf = (month: string): number => {
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

  const ownCutoff = cutoffOf(ownMonth);
  const day = Number(workDate.slice(8, 10));
  const ownMonthOwns = day <= ownCutoff;
  const owner = ownMonthOwns ? ownMonth : successor;

  // Serialize against the month lock (and the owning month's run write)
  // BEFORE reading the lock row: the shared lock holds to COMMIT and the
  // lock takes the same key exclusively for its decide+insert, so this read
  // cannot go stale before the correction commits.
  await tx.query(
    `select pg_advisory_xact_lock_shared(hashtextextended($1::text, 0))`,
    [payrollRunAdvisoryKey(tenantId, owner)],
  );
  const lockRes = await tx.query<{ month: string }>(
    `select month from public.payroll_month_locks
     where tenant_id = $1::uuid and month = $2`,
    [tenantId, owner],
  );
  if (lockRes.rows.length === 0) return;

  if (ownMonthOwns) {
    throw lockedError(
      `${owner} is locked for payroll — ${workDate} falls on or before its day-${ownCutoff} cut-off, so it can no longer be corrected`,
    );
  }
  throw lockedError(
    `${owner} is locked for payroll and owns ${workDate} (after ${ownMonth}'s day-${ownCutoff} cut-off) — the date can no longer be corrected`,
  );
}
