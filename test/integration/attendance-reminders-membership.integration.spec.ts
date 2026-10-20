/**
 * attendance_run_reminders and membership state (migration 20261020000006) —
 * real DEV database suite. Requirement: only ACTIVE, enabled employees get a
 * reminder and count in the owner's "not checked in" office summary; a
 * removed, invited or disabled person gets nothing and is not counted.
 *
 * The function takes its clock as an argument, so each test ticks it at 12:00
 * of its OWN past date (never today), which keeps the live pg_cron job from
 * interfering. Requires a real database (skipped when DATABASE_URL is a stub).
 */
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { purgeCompanyChildren } from '../helpers/attendance-company-fixture';
import { randomPhone } from '../helpers/member-functions-fixture';

const DATABASE_URL = process.env['DATABASE_URL'] ?? '';
const SUPABASE_URL = process.env['SUPABASE_URL'] ?? '';
const IS_REAL_DB =
  DATABASE_URL !== '' &&
  !DATABASE_URL.includes('test:test') &&
  !SUPABASE_URL.includes('test.supabase.co') &&
  !SUPABASE_URL.includes('pnlvreaijzslfymlnoti');

const TZ = 'Asia/Kolkata';
const TENANT = randomUUID();
const P = {
  owner: randomUUID(),
  active: randomUUID(),
  removed: randomUUID(),
  disabled: randomUUID(),
  invited: randomUUID(),
};
const EMPLOYEES = [P.active, P.removed, P.disabled, P.invited];
const ALL = [P.owner, ...EMPLOYEES];
type State = 'active' | 'removed' | 'invited';

jest.setTimeout(120_000);

describe('attendance_run_reminders ignores non-active members (real DB)', () => {
  const maybeIt = IS_REAL_DB ? it : it.skip;
  let pool: Pool;
  let today = '';
  let officeId = '';

  const dayBefore = (n: number) =>
    pool
      .query<{ d: string }>(`select ($1::date - $2::int)::text as d`, [
        today,
        n,
      ])
      .then((r) => r.rows[0].d);

  /** Put the four employees into the given state (all enrolled and assigned). */
  const setPeople = async (
    state: Record<'active' | 'removed' | 'disabled' | 'invited', State>,
    disabled: string[] = [P.disabled],
  ) => {
    for (const [who, status] of Object.entries(state)) {
      await pool.query(
        `update public.memberships set status = $3 where user_id = $1 and tenant_id = $2`,
        [P[who as keyof typeof P], TENANT, status],
      );
    }
    await pool.query(
      `update public.users set disabled = (id = any($1::uuid[])) where id = any($2::uuid[])`,
      [disabled, EMPLOYEES],
    );
  };
  const REGULAR = {
    active: 'active',
    removed: 'removed',
    disabled: 'active',
    invited: 'invited',
  } as const;

  const tickAt = async (date: string) => {
    await pool.query(
      'select public.attendance_run_reminders($1::timestamptz)',
      [`${date} 12:00:00+05:30`],
    );
    const { rows } = await pool.query<{
      user_id: string;
      event_type: string;
      payload: Record<string, unknown>;
    }>(
      `select user_id, event_type, payload from public.notifications
        where tenant_id = $1 and payload->>'workDate' = $2
          and event_type in ('attendance.reminder_checkin',
                             'attendance.reminder_checkout',
                             'attendance.reminder_not_checked_in')`,
      [TENANT, date],
    );
    return rows;
  };

  const cleanup = async () => {
    const stale = await pool.query<{ id: string }>(
      `select id from public.tenants where company_name like 'MFQA reminders%'`,
    );
    const ids = [...new Set([TENANT, ...stale.rows.map((r) => r.id)])];
    await purgeCompanyChildren(pool, ids);
    await pool.query('delete from public.tenants where id = any($1::uuid[])', [
      ids,
    ]);
    await pool.query('delete from public.users where id = any($1::uuid[])', [
      ALL,
    ]);
  };

  beforeAll(async () => {
    if (!IS_REAL_DB) return;
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 2,
    });
    await cleanup();
    today = (
      await pool.query<{ d: string }>(
        `select (now() at time zone $1)::date::text as d`,
        [TZ],
      )
    ).rows[0].d;
    await pool.query('begin');
    await pool.query(
      `insert into public.users (id, name, country_code, phone_number)
       select u, 'MFQA reminder person', '+91', ph
         from unnest($1::uuid[], $2::text[]) as t(u, ph)`,
      [ALL, ALL.map(() => randomPhone())],
    );
    await pool.query(
      `insert into public.tenants (id, created_by, company_name, state_code, timezone)
       values ($1, $2, 'MFQA reminders', 'KA', $3)`,
      [TENANT, P.owner, TZ],
    );
    await pool.query(
      `insert into public.memberships (user_id, tenant_id, role, status)
       select u, $1, case when u = $2 then 'company_admin' else 'employee' end, 'active'
         from unnest($3::uuid[]) as t(u)`,
      [TENANT, P.owner, ALL],
    );
    await pool.query(
      `insert into public.attendance_settings (tenant_id, enabled, setup_completed_at)
       values ($1, true, now())`,
      [TENANT],
    );
    officeId = (
      await pool.query<{ id: string }>(
        `insert into public.attendance_offices (tenant_id, name, latitude, longitude, radius_m)
         values ($1, 'HQ', 12.9716, 77.5946, 100) returning id`,
        [TENANT],
      )
    ).rows[0].id;
    await pool.query(
      `insert into public.attendance_office_rules
         (office_id, tenant_id, valid, start_time, end_time, late_cutoff_minutes, full_day_hours, half_day_hours)
       values ($1, $2, daterange(current_date - 60, current_date + 120), '09:30', '18:30', 15, 8, 4)`,
      [officeId, TENANT],
    );
    for (const e of EMPLOYEES) {
      await pool.query(
        `insert into public.attendance_office_assignments (tenant_id, employee_id, office_id, valid)
         values ($1, $2, $3, daterange(current_date - 60, current_date + 120))`,
        [TENANT, e, officeId],
      );
      await pool.query(
        `insert into public.attendance_enrolments (tenant_id, employee_id, valid, enabled_at)
         values ($1, $2, daterange(current_date - 60, current_date + 120), now() - interval '60 days')`,
        [TENANT, e],
      );
    }
    await pool.query('commit');
  });

  afterAll(async () => {
    if (!IS_REAL_DB) return;
    await cleanup();
    await pool.end();
  });

  maybeIt(
    'a removed, invited or disabled employee gets no reminder and is left out of the office summary count',
    async () => {
      const date = await dayBefore(1);
      await setPeople(REGULAR);
      const rows = await tickAt(date);
      const checkin = rows.filter(
        (r) => r.event_type === 'attendance.reminder_checkin',
      );
      expect(checkin.map((r) => r.user_id)).toEqual([P.active]); // control: the active one IS reminded
      const summary = rows.filter(
        (r) => r.event_type === 'attendance.reminder_not_checked_in',
      );
      expect(summary).toHaveLength(1);
      expect(summary[0].user_id).toBe(P.owner);
      expect(summary[0].payload).toMatchObject({
        officeName: 'HQ',
        notCheckedInCount: 1,
      });
      const { rows: leaked } = await pool.query(
        `select 1 from public.notifications where tenant_id = $1 and user_id = any($2::uuid[])`,
        [TENANT, [P.removed, P.disabled, P.invited]],
      );
      expect(leaked).toEqual([]);
    },
  );

  maybeIt(
    'with NO active enabled employee left, nothing at all is sent (no reminders, no empty summary)',
    async () => {
      const date = await dayBefore(2);
      await setPeople({ ...REGULAR, active: 'removed' });
      expect(await tickAt(date)).toEqual([]);
    },
  );

  maybeIt(
    'the filter follows the current state: a re-activated and re-enabled person is reminded and counted again',
    async () => {
      const date = await dayBefore(3);
      await setPeople(
        {
          active: 'active',
          removed: 'active',
          disabled: 'active',
          invited: 'active',
        },
        [],
      );
      const rows = await tickAt(date);
      const checkin = rows.filter(
        (r) => r.event_type === 'attendance.reminder_checkin',
      );
      expect(checkin.map((r) => r.user_id).sort()).toEqual(
        [...EMPLOYEES].sort(),
      );
      const summary = rows.find(
        (r) => r.event_type === 'attendance.reminder_not_checked_in',
      );
      expect(summary?.payload).toMatchObject({ notCheckedInCount: 4 });
    },
  );

  maybeIt(
    'a person disabled while still active is excluded even though the membership row says active',
    async () => {
      const date = await dayBefore(4);
      await setPeople({ ...REGULAR, removed: 'active', invited: 'active' }, [
        P.removed,
        P.invited,
        P.disabled,
      ]);
      const rows = await tickAt(date);
      expect(
        rows
          .filter((r) => r.event_type === 'attendance.reminder_checkin')
          .map((r) => r.user_id),
      ).toEqual([P.active]);
      const summary = rows.find(
        (r) => r.event_type === 'attendance.reminder_not_checked_in',
      );
      expect(summary?.payload).toMatchObject({ notCheckedInCount: 1 });
    },
  );

  it('(always) suite is wired', () => {
    expect(true).toBe(true);
  });
});
