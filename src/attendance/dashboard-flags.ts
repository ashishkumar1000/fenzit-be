import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { internalError } from './attendance-rpc.helpers';
import type {
  CheckoutMissingFlagRow,
  FakeLocationFlagRow,
} from './dashboard-response.model';

/**
 * 19-2's targeted FLAG reads (spec D5) — deliberately NOT the full grid
 * (a since-enable flag window has no 62-day cap, so the engine's 50×31
 * budgeted read is the wrong tool here). Their predicates mirror the
 * day-status engine's rules exactly — that equivalence is pinned by the
 * §6 parity probe, not assumed:
 *  - checkout-missing ← engine rule 8 (past tracked days, check-in
 *    without check-out, `effectiveInstants()`'s per-field override
 *    substitution included — override-only days count too), gated by
 *    rule 2's tracked predicate (untracked days read `not_tracked` and
 *    never flag) and suppressed by rule 1's status-override adjudication.
 *  - fake-location ← the engine's unacknowledged-mocked-attempt fact
 *    (AD-10), grouped per employee-date with attempt counts; clears on
 *    acknowledge.
 *
 * Injectable so files stay small and the house module structure holds;
 * both reads run inside the dashboard's ONE transaction.
 */

const logger = new Logger('DashboardFlags');

/** Shared flag-row shape: name resolved server-side, count as pg text. */
export interface RawFlagRow {
  employee_id: string;
  work_date: string;
  employee_name: string;
  office_name: string | null;
  attempt_count: string;
}

/**
 * The officeId filter BODY: the employee whose covering assignment office
 * TODAY matches — the same filter predicate the tiles use (D5; unknown-
 * but-well-formed officeId → no rows match, 200, never 404). Both reads
 * wrap it in ONE `exists (…)` — the clause ships without its own so the
 * substituted text parses once (the real-DB strip probe caught an older
 * self-nesting spelling erroring on every dashboard read).
 */
const TODAY_OFFICE_FILTER_BODY = `select 1
  from public.attendance_office_assignments aex
  where aex.employee_id = %ALIAS%.employee_id
    and aex.tenant_id = $1::uuid
    and aex.valid @> $2::date
    and aex.office_id = $3::uuid`;

@Injectable()
export class DashboardFlagReads {
  /**
   * Flag (a): PAST dates with an EFFECTIVE check-in and no effective
   * check-out, no adjudicating override — engine rule 8's exact set. The
   * gate runs on the effective instants (the `coalesce` pair IS
   * `effectiveInstants()`'s per-field substitution: a times-only override
   * supplying `manual_checkout_at` completes the day and clears the flag;
   * an override-supplied check-in over a raw-null record counts), the
   * `ovd.status is null` arms mirror rule 1's adjudication short-circuit,
   * and the second arm carries override-only days (a manual check-in with
   * no record row). Cleared by a status correction landing; a times-only
   * correction clears it only by completing the pair.
   */
  readCheckoutMissing(
    tx: PoolClient,
    tenantId: string,
    today: string,
    officeId: string | null,
  ): Promise<CheckoutMissingFlagRow[]> {
    return tx
      .query<RawFlagRow>(
        `select d.employee_id, d.work_date::text,
                coalesce(nullif(u.name, ''), u.country_code || u.phone_number,
                         'Unknown employee') as employee_name,
                oact.name as office_name, '' as attempt_count
         from (
           select r.employee_id, r.work_date,
                  coalesce(ovd.manual_checkin_at, r.checkin_at) as checkin_at,
                  coalesce(ovd.manual_checkout_at, r.checkout_at) as checkout_at
           from public.attendance_records r
           left join public.attendance_day_overrides ovd
             on ovd.tenant_id = r.tenant_id
            and ovd.employee_id = r.employee_id
            and ovd.work_date = r.work_date
            and ovd.deleted_at is null
           where r.tenant_id = $1::uuid
             and r.work_date < $2::date
             and ovd.status is null

           union

           select ovd.employee_id, ovd.work_date,
                  ovd.manual_checkin_at, ovd.manual_checkout_at
           from public.attendance_day_overrides ovd
           where ovd.tenant_id = $1::uuid
             and ovd.work_date < $2::date
             and ovd.deleted_at is null
             and ovd.status is null
             and not exists (
               select 1 from public.attendance_records r2
               where r2.tenant_id = ovd.tenant_id
                 and r2.employee_id = ovd.employee_id
                 and r2.work_date = ovd.work_date
             )
         ) d
         join public.users u on u.id = d.employee_id
         -- rule 2's tracked gate: an untracked past day reads
         -- not_tracked and never flags (enrolment ∩ assignment ∩ active
         -- office ∩ setup completed ∩ enabled, all covering the FLAG
         -- date; the engine marks those rows not_tracked and rule 8
         -- never marks them).
         join public.attendance_settings st
           on st.tenant_id = $1::uuid
          and st.enabled is true
          and st.setup_completed_at is not null
         join public.attendance_enrolments e
           on e.tenant_id = $1::uuid and e.employee_id = d.employee_id
          and e.valid @> d.work_date
         join public.attendance_office_assignments a4
           on a4.employee_id = d.employee_id and a4.tenant_id = $1::uuid
          and a4.valid @> d.work_date
         join public.attendance_offices oact
           on oact.id = a4.office_id and oact.archived_at is null
         where d.checkin_at is not null
           and d.checkout_at is null
           and ($3::uuid is null or exists (
           ${TODAY_OFFICE_FILTER_BODY.replace('%ALIAS%', 'd')}
         ))
         order by d.work_date asc, employee_name asc`,
        [tenantId, today, officeId],
      )
      .then((r) =>
        r.rows.map((row) => ({
          employeeId: row.employee_id,
          employeeName: row.employee_name,
          workDate: row.work_date,
          officeName: row.office_name,
        })),
      );
  }

  /**
   * Flag (b): every unacknowledged `mocked` attempt, grouped per
   * employee-date by the ATTEMPT date (the office shown is the
   * assignment covering that date). `attempt_count` arrives as text
   * (pg bigint) — Number()ed at the wire.
   */
  readFakeLocation(
    tx: PoolClient,
    tenantId: string,
    today: string,
    timezone: string,
    officeId: string | null,
  ): Promise<FakeLocationFlagRow[]> {
    return tx
      .query<RawFlagRow>(
        `select f.employee_id, f.work_date::text,
                coalesce(nullif(u.name, ''), u.country_code || u.phone_number,
                         'Unknown employee') as employee_name,
                o.name as office_name,
                f.attempt_count
         from (
           select employee_id,
                  (attempted_at at time zone $4::text)::date as work_date,
                  count(*)::text as attempt_count
           from public.attendance_attempts
           where tenant_id = $1::uuid
             and outcome = 'mocked'
             and acknowledged_at is null
           group by employee_id, work_date
         ) f
         -- The strips share the tracked gate's settings component: with
         -- the module off the engine's grid carries no AD-10 facts, so
         -- this strip is empty too (same parity gate as flag (a)).
         join public.attendance_settings st
           on st.tenant_id = $1::uuid
          and st.enabled is true
          and st.setup_completed_at is not null
         join public.users u on u.id = f.employee_id
         left join lateral (
           select a2.office_id
           from public.attendance_office_assignments a2
           where a2.employee_id = f.employee_id
             and a2.tenant_id = $1::uuid
             and a2.valid @> f.work_date
           limit 1
         ) a on true
         left join public.attendance_offices o on o.id = a.office_id
         where ($3::uuid is null or exists (
           ${TODAY_OFFICE_FILTER_BODY.replace('%ALIAS%', 'f')}
         ))
         order by f.work_date asc, employee_name asc`,
        [tenantId, today, officeId, timezone],
      )
      .then((r) =>
        r.rows.map((row) => ({
          employeeId: row.employee_id,
          employeeName: row.employee_name,
          workDate: row.work_date,
          officeName: row.office_name,
          attemptCount: Number(row.attempt_count),
        })),
      );
  }

  /**
   * The stored IANA timezone (the attempts read bucketises
   * attempted_at by tenant-local date).
   */
  async readTimezone(tx: PoolClient, tenantId: string): Promise<string> {
    const { rows } = await tx.query<{ timezone: string }>(
      'select timezone from public.tenants where id = $1::uuid',
      [tenantId],
    );
    const tz = rows[0]?.timezone;
    if (!tz) {
      logger.error('Tenant timezone missing', { tenantId });
      throw internalError('Failed to resolve the dashboard');
    }
    return tz;
  }
}
