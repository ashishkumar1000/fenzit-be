import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { PgPoolFactory } from '../common/pg/pg-pool.factory';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { requireTenant } from './attendance-rpc.helpers';
import { tenantToday } from './enrolments.repository';
import { readDayStatusGrid } from './day-status.read';
import { computeDayStatus, effectiveInstants } from './day-status.model';
import { DashboardFlagReads } from './dashboard-flags';
import type { DashboardResponse } from './dashboard-response.model';

/**
 * 19-2's owner dashboard read (spec D5): FR-24's five tiles + the two
 * unresolved-past-flag strips. The tiles are derived from ONE engine grid
 * read — `readDayStatusGrid(tx, tenantId, trackedTodayIds, today, today)`
 * — so a tile and the calendar can never disagree (FR-10 lives only in
 * `computeDayStatus`); the flags run two targeted reads mirroring the
 * engine's rules 8/ad-10 exactly (dashboard-flags.ts, parity-pinned by
 * the §6 suite). No new SQL functions.
 *
 * The optional `officeId` filters the tiles by TODAY's covering
 * assignment office, and the flag strips to employees whose
 * covering-assignment office TODAY matches (unknown-but-well-formed
 * officeId → 200 with zeros + empty flags — a filter is not an entity
 * fetch, never 404). Employees on a future start date are excluded from
 * every count automatically (the engine marks them `not_tracked` for
 * today — FR-2's rule, consumed not re-implemented).
 */

/** D5's checked-in set — engine-authoritative, includes overrides. The
 *  `half_day_leave` member additionally requires a check-in instant at the
 *  counting site (rule 6 grades a never-appeared half-day leaver with no
 *  check-in at all — that row is leave, not a check-in). */
const CHECKED_IN_STATUSES = new Set([
  'in_progress',
  'present',
  'half_day',
  'half_day_leave',
  'worked_on_holiday',
]);

/** D5's on-leave statuses (half_day_leave overlaps with checkedIn). */
const ON_LEAVE_STATUSES = new Set(['leave', 'half_day_leave']);

interface TrackedTodayRow {
  employee_id: string;
}

@Injectable()
export class DashboardService {
  constructor(
    private readonly pg: PgPoolFactory,
    private readonly flags: DashboardFlagReads,
  ) {}

  today(owner: RequestUser, officeId?: string): Promise<DashboardResponse> {
    const tenantId = requireTenant(owner);
    return this.pg.withTransaction(async (tx) => {
      const today = await tenantToday(tx, tenantId);
      const employeeIds = await this.readTrackedTodayEmployeeIds(
        tx,
        tenantId,
        today,
        officeId ?? null,
      );

      // Tiles: derived ONLY from the engine's outcomes over today's rows —
      // no tile has a second implementation to drift from FR-10.
      const counts = {
        tracked: 0,
        checkedIn: 0,
        notCheckedIn: 0,
        late: 0,
        onLeave: 0,
      };
      if (employeeIds.length > 0) {
        const rows = await readDayStatusGrid(
          tx,
          tenantId,
          employeeIds,
          today,
          today,
        );
        for (const row of rows) {
          if (!row.ctx.tracked) continue;
          counts.tracked += 1;
          const outcome = computeDayStatus({
            ctx: row.ctx,
            record: row.record,
            override: row.override,
            hasUnackMockedAttempt: row.hasUnackMockedAttempt,
            today: row.today,
          });
          const checkedIn =
            CHECKED_IN_STATUSES.has(outcome.status) &&
            (outcome.status !== 'half_day_leave' ||
              effectiveInstants(row.record, row.override).checkin !== null);
          if (checkedIn) {
            // D5's letter: `checkedIn` counts rows with a check-in instant
            // today. A never-appeared half_day_leave (rule 6 grades the
            // approved half-day leave with NO check-in at all) is leave,
            // not a check-in — the audit's over-count. Every other set
            // member carries an instant by definition (the tile still
            // overlaps `onLeave` with the checked-in half).
            counts.checkedIn += 1;
          }
          if (outcome.status === 'not_checked_in_yet') {
            counts.notCheckedIn += 1;
          }
          if (outcome.isLate) counts.late += 1;
          if (ON_LEAVE_STATUSES.has(outcome.status)) counts.onLeave += 1;
        }
      }

      const tz = await this.flags.readTimezone(tx, tenantId);
      const [checkoutMissing, fakeLocationAttempt] = await Promise.all([
        this.flags.readCheckoutMissing(tx, tenantId, today, officeId ?? null),
        this.flags.readFakeLocation(
          tx,
          tenantId,
          today,
          tz,
          officeId ?? null,
        ),
      ]);
      return {
        date: today,
        counts,
        flags: { checkoutMissing, fakeLocationAttempt },
      };
    });
  }

  /**
   * Today's candidate set — the gate-2 predicate of
   * `attendance_complete_setup` (enrolment ∩ assignment ∩ active office,
   * all covering today), optionally scoped to one office. No settings
   * check here on purpose: the engine's rule 2 marks every row
   * `not_tracked` when the module is off, so the tiles zero honestly
   * (consumed, not re-implemented).
   */
  private async readTrackedTodayEmployeeIds(
    tx: PoolClient,
    tenantId: string,
    today: string,
    officeId: string | null,
  ): Promise<string[]> {
    const { rows } = await tx.query<TrackedTodayRow>(
      `select distinct a.employee_id
       from public.attendance_enrolments e
       join public.attendance_office_assignments a
         on a.employee_id = e.employee_id and a.tenant_id = e.tenant_id
        and a.valid @> $2::date
       join public.attendance_offices o on o.id = a.office_id
       where e.tenant_id = $1::uuid
         and e.valid @> $2::date
         and o.archived_at is null
         and ($3::uuid is null or a.office_id = $3::uuid)
       order by a.employee_id`,
      [tenantId, today, officeId],
    );
    return rows.map((r) => r.employee_id);
  }
}
