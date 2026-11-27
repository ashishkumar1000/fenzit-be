import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { ErrorCode } from '../common/enums/error-code.enum';
import type { PoolClient } from 'pg';
import { PgPoolFactory } from '../common/pg/pg-pool.factory';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { requireTenant } from './attendance-rpc.helpers';
import { readDayStatusGrid } from '../common/day-status/grid-reader';
import { computeDayStatus } from '../common/day-status/day-status.model';
import { bucketOfOutcome } from './dashboard';
import type {
  AttendanceTrendDay,
  AttendanceTrendResponse,
} from './trend-response.model';

/**
 * The 2026-11-27 exec-dashboard attendance trend (`GET /attendance/trend`):
 * the today-pulse's bucket partition, evaluated for every day of a window so
 * the overview can draw the distribution over time. ONE engine grid read
 * (`readDayStatusGrid` over the whole range — its batched shape is the
 * 50-employee × 31-day NFR-7 budget) and the identical
 * `computeDayStatus` → bucket mapping as `DashboardService.today`, so the
 * chart can never disagree with the tiles or the calendar (FR-10 lives only
 * in the engine). No new SQL functions, no second partition rule.
 *
 * The window is capped: the grid assembles one row per employee-day, so the
 * chart admits 62 days (two months) — far beyond the console's presets
 * (7D / 30 Days / This month) and still inside the batch budget.
 */

const MAX_TREND_DAYS = 62;

const DAY_MS = 24 * 60 * 60 * 1000;

interface TrackedInRangeRow {
  employee_id: string;
}

/** YYYY-MM-DD that is a real calendar day (rejects 2026-02-30, 2026-13-01). */
function isRealDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === mo - 1 &&
    dt.getUTCDate() === d
  );
}

function reject(message: string): never {
  throw new UnprocessableEntityException({
    error_code: ErrorCode.VALIDATION_ERROR,
    message,
  });
}

@Injectable()
export class AttendanceTrendService {
  constructor(private readonly pg: PgPoolFactory) {}

  async trend(
    owner: RequestUser,
    fromRaw: string,
    toRaw: string,
  ): Promise<AttendanceTrendResponse> {
    if (!isRealDate(fromRaw)) reject('from must be a real calendar date (YYYY-MM-DD)');
    if (!isRealDate(toRaw)) reject('to must be a real calendar date (YYYY-MM-DD)');
    const spanDays =
      (Date.parse(`${toRaw}T00:00:00Z`) - Date.parse(`${fromRaw}T00:00:00Z`)) /
      DAY_MS;
    if (spanDays < 0) reject('from must be on or before to');
    if (spanDays + 1 > MAX_TREND_DAYS) {
      reject(`The attendance trend can cover at most ${MAX_TREND_DAYS} days`);
    }
    const tenantId = requireTenant(owner);

    return this.pg.withTransaction(async (tx) => {
      const employeeIds = await this.readTrackedInRangeEmployeeIds(
        tx,
        tenantId,
        fromRaw,
        toRaw,
      );

      // Every date starts at honest zeros — a day with no tracked employee
      // (or none enrolled yet) renders an empty chart row, never a gap.
      const days = new Map<string, AttendanceTrendDay>();
      let cursor = fromRaw;
      while (cursor <= toRaw) {
        days.set(cursor, {
          date: cursor,
          tracked: 0,
          checkedIn: 0,
          notCheckedIn: 0,
          shortDay: 0,
          late: 0,
          onLeave: 0,
        });
        const [y, m, d] = cursor.split('-').map(Number);
        cursor = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
      }

      if (employeeIds.length > 0) {
        const rows = await readDayStatusGrid(
          tx,
          tenantId,
          employeeIds,
          fromRaw,
          toRaw,
        );
        for (const row of rows) {
          // The same tracked gate as the pulse tiles: the engine marks a
          // future start date (FR-2) and every not-covered day not_tracked.
          if (!row.ctx.tracked) continue;
          const outcome = computeDayStatus({
            ctx: row.ctx,
            record: row.record,
            override: row.override,
            hasUnackMockedAttempt: row.hasUnackMockedAttempt,
            today: row.today,
          });
          const day = days.get(row.workDate);
          // The grid never returns a date outside [from, to]; the guard is
          // for the type, never a real state.
          if (day === undefined) continue;
          // THE dashboard's partition — the shared classifier in
          // dashboard.ts, so the chart can never disagree with the tiles
          // (late qualifies the checked-in rows only).
          const bucket = bucketOfOutcome(outcome, row.override?.status);
          day.tracked += 1;
          if (bucket === 'checked_in') {
            day.checkedIn += 1;
            if (outcome.isLate) day.late += 1;
          } else if (bucket === 'on_leave') {
            day.onLeave += 1;
          } else if (bucket === 'short_day') {
            day.shortDay += 1;
          } else {
            day.notCheckedIn += 1;
          }
        }
      }

      return {
        range: { from: fromRaw, to: toRaw },
        days: [...days.values()],
      };
    });
  }

  /**
   * The trend's candidate set — the gate-2 predicate of
   * `attendance_complete_setup` overlapping ANY day of the range (the pulse's
   * today-only read widened to `&&`). The engine grades each day's
   * tracked-ness itself, so over-inclusion here is safe: a row outside its
   * covering window reads not_tracked and never reaches the buckets.
   */
  private async readTrackedInRangeEmployeeIds(
    tx: PoolClient,
    tenantId: string,
    from: string,
    to: string,
  ): Promise<string[]> {
    const { rows } = await tx.query<TrackedInRangeRow>(
      `select distinct a.employee_id
       from public.attendance_enrolments e
       join public.attendance_office_assignments a
         on a.employee_id = e.employee_id and a.tenant_id = e.tenant_id
        and a.valid && $2::daterange
       join public.attendance_offices o on o.id = a.office_id
       where e.tenant_id = $1::uuid
         and e.valid && $2::daterange
         and o.archived_at is null
       order by a.employee_id`,
      [tenantId, `[${from},${to}]`],
    );
    return rows.map((r) => r.employee_id);
  }
}
