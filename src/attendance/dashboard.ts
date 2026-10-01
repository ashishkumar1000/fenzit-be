import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { PgPoolFactory } from '../common/pg/pg-pool.factory';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { requireTenant } from './attendance-rpc.helpers';
import { tenantToday } from './enrolments.repository';
import { readDayStatusGrid } from './day-status.read';
import { computeDayStatus } from './day-status.model';
import { DashboardFlagReads } from './dashboard-flags';
import type { DashboardResponse, DashboardOfficeRow } from './dashboard-response.model';

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

/** D5's on-leave statuses. On TODAY the buckets PARTITION tracked (the
 *  2026-10-01 user ruling — checkedIn + notCheckedIn + onLeave must add
 *  up to tracked): the bucket follows the OUTCOME STATUS (the same grade
 *  the calendar cell shows — the module header's tile/calendar invariant),
 *  not the raw punch instants: a presence status is "checked in", a leave
 *  grade is "on leave", and everything else — an owner-adjudicated
 *  `absent` override included — reads not checked in (the rule-7
 *  carve-out lives at the end of this block).
 *  The earlier half_day_leave/checked-in overlap is dropped: a half-day
 *  leaver reads on leave, their worked half staying a day-sheet/summary
 *  truth (FR-11's never-mixed rule). Late stays a qualifier of checked
 *  in — it only counts inside the checked-in bucket. (NOT the same
 *  question as the reminder RPC's `notCheckedInCount` — that one keys on
 *  raw instants with its own conditions for past-cutoff nudges.)
 *
 *  20-2 (the user's 2026-10-01 follow-up): the rule-7 `absent` a
 *  punch-in AND punch-out under the half-day threshold grades now OWN
 *  their "Short day" bucket — parking a visible punch-in under "not
 *  checked in" misled the owner. So the partition's absent status
 *  SPLITS by origin: ENGINE-graded (no owner status override, worked
 *  minutes present) → shortDay; owner-adjudicated (rule 1) and the
 *  past-no-check-in grade (rule 9, no worked minutes) stay not checked
 *  in — the owner's word overrides the tile, always. */
const CHECKED_IN_STATUSES = new Set([
  'in_progress',
  'present',
  'half_day',
  'worked_on_holiday',
]);

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
      // TENANT-WIDE candidate set, filter in code: the same engine grid
      // read also feeds the per-office stats (the 19-4 office picker's
      // subtitles), so counting through SQL's office filter would need a
      // second read (or a drifted per-office recomputation).
      const employeeIds = await this.readTrackedTodayEmployeeIds(
        tx,
        tenantId,
        today,
      );

      // Tiles: derived ONLY from the engine's outcomes over today's rows —
      // no tile has a second implementation to drift from FR-10.
      const counts = {
        tracked: 0,
        checkedIn: 0,
        notCheckedIn: 0,
        late: 0,
        onLeave: 0,
        // 20-2: live since the partition flip — the engine-graded
        // rule-7 short-day rows (see the route comment below).
        shortDay: 0,
      };
      /** The office registry with today's stats (the picker's subtitles) —
       *  offices with zero tracked employees included (the mock lists
       *  them). */
      const officeStats = new Map<
        string,
        { id: string; name: string; tracked: number; checkedIn: number }
      >();
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
          const outcome = computeDayStatus({
            ctx: row.ctx,
            record: row.record,
            override: row.override,
            hasUnackMockedAttempt: row.hasUnackMockedAttempt,
            today: row.today,
          });
          // The bucket key is the OUTCOME STATUS — the same grade the
          // calendar cell and the day sheet show, so a tile can never
          // disagree with them (presence statuses carry an instant by
          // construction — rules 7/10 and rule 3 require a punch, and a
          // rule-1 presence override grades the day present exactly as
          // the calendar reads it). The 2026-10-01 user ruling: the three
          // buckets add up to `tracked` — a sub-half-day punch-in/out
          // grades `absent` and NO LONGER vanishes (it counts not checked
          // in), nor does a weekly-off/holiday row.
          const checkedIn = CHECKED_IN_STATUSES.has(outcome.status);

          // Per-office tallies over the FULL tenant scope (the picker must
          // list every office with its own truth, whatever this fetch's
          // filter is), from the same rows — one grid, no second source.
          // This accumulation MUST run before the filter below: a filtered
          // fetch still reports every office its own counts.
          const rowOfficeId = row.ctx.officeId;
          if (rowOfficeId !== null) {
            const entry = officeStats.get(rowOfficeId) ?? {
              id: rowOfficeId,
              name: row.ctx.officeName ?? '',
              tracked: 0,
              checkedIn: 0,
            };
            entry.tracked += 1;
            if (checkedIn) entry.checkedIn += 1;
            officeStats.set(rowOfficeId, entry);
          }

          // The office filter is today's covering assignment office —
          // the code-side equivalent of the old SQL's a.office_id match.
          // Applied AFTER the tallies: it shapes ONLY the tiles.
          if (officeId !== undefined && row.ctx.officeId !== officeId) {
            continue;
          }

          counts.tracked += 1;
          // The partition (the CHECKED_IN_STATUSES docblock's ruling):
          // presence → checked in, leave → on leave, and the `absent`
          // status splits BY ORIGIN — the engine's rule-7 short-day grade
          // (no override status, worked minutes on the outcome; rule 9's
          // no-punch absent has workedMinutes null, rule 1 is excluded by
          // the override) → Short day; everything else —
          // not_checked_in_yet, weekly_off, holiday, owner-adjudicated
          // `absent`, rule-9 `absent` — is not checked in. Rows MOVE,
          // never copy: one tracked row lands in exactly one bucket.
          if (checkedIn) {
            counts.checkedIn += 1;
          } else if (ON_LEAVE_STATUSES.has(outcome.status)) {
            counts.onLeave += 1;
          } else if (
            outcome.status === 'absent' &&
            row.override?.status == null &&
            outcome.workedMinutes !== null
          ) {
            counts.shortDay += 1;
          } else {
            counts.notCheckedIn += 1;
          }
          // Late qualifies the CHECKED-IN rows only — a late flag can
          // never read against a not-checked-in or on-leave person.
          if (checkedIn && outcome.isLate) counts.late += 1;
        }
      }
      const offices: DashboardOfficeRow[] = await this.readOfficeRegistry(
        tx,
        tenantId,
        officeStats,
      );

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
        offices,
        flags: { checkoutMissing, fakeLocationAttempt },
      };
    });
  }

  /**
   * Today's candidate set — the gate-2 predicate of
   * `attendance_complete_setup` (enrolment ∩ assignment ∩ active office,
   * all covering today). No settings check here on purpose: the engine's
   * rule 2 marks every row `not_tracked` when the module is off, so the
   * tiles zero honestly (consumed, not re-implemented).
   */
  private async readTrackedTodayEmployeeIds(
    tx: PoolClient,
    tenantId: string,
    today: string,
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
       order by a.employee_id`,
      [tenantId, today],
    );
    return rows.map((r) => r.employee_id);
  }

  /** The picker's registry — every NON-ARCHIVED attendance office in
   *  display name order, its stats from the grid when it has tracked
   *  employees today and zeros otherwise. Offices that are archived drop
   *  out (the same predicate the filter sheet's list has always used). */
  private async readOfficeRegistry(
    tx: PoolClient,
    tenantId: string,
    officeStats: Map<
      string,
      { name: string; tracked: number; checkedIn: number }
    >,
  ): Promise<DashboardOfficeRow[]> {
    const { rows } = await tx.query<{ id: string; name: string }>(
      `select id, name
       from public.attendance_offices
       where tenant_id = $1::uuid and archived_at is null
       order by name`,
      [tenantId],
    );
    return rows.map(({ id, name }) => {
      const stats = officeStats.get(id);
      return {
        id,
        name,
        tracked: stats?.tracked ?? 0,
        checkedIn: stats?.checkedIn ?? 0,
      };
    });
  }
}
