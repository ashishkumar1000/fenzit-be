/**
 * 19-1's real-DB journey — `attendance_run_reminders()` (migration
 * 20260929000004).
 *
 * One throwaway tenant whose facts are seeded on a crafted probe date D (a
 * non-Sunday inside every validity window, so the suite is independent of
 * the day it runs on). The function's injected clock `p_now` drives all
 * four timing arms deterministically:
 *   - 08:00  → NOTHING (before every due instant),
 *   - 12:00  → check-in arm (Start + cut-off = 09:45), the owner summary
 *              (count 3: noCheckin + pendLeave + halfLeave), and the
 *              pending-leave alert (pending leaves suppress nothing; an
 *              approved full-day leave does),
 *   - 13:00  → a re-run absorbs EVERYTHING — zero new (the dedupe key IS
 *              the idempotency guarantee),
 *   - 14:00  → exactly the approved second-half checkout (Midpoint + late
 *              = 14:00, its late minutes being 0), while the displaced
 *              first-half check-in (Midpoint + cut-off = 14:15) is still
 *              short of its instant — a sharp boundary between the two
 *              shifted arms,
 *   - 14:30  → the displaced first-half check-in,
 *   - 18:00  → nothing still (the punctual check-out is due at EXACTLY
 *              18:30 — the 2026-09-29 ruling: late = 0 → due at Expected
 *              end, not earlier),
 *   - 18:30  → the punctual open day and the manual-07:00 override day
 *              both fire,
 *   - 18:45  → the 09:56 check-in's late-shifted due (18:41) fires one
 *              5-minute tick late, and an 18:50 re-run absorbs it.
 * Also pinned: the tenant holiday D2 suppresses every employee arm but NOT
 * the pending alert (its count is tenant-wide, not per-day), the AD-25
 * setup gate (tenant C has COMPLETE facts but never completes setup → it
 * stays notification-less), and per-tenant loop independence (AD-14: a
 * second fully-fact-armed tenant's reminders fire in the SAME ticks as the
 * first's, with its own payload facts and zero cross-leakage). Timezone
 * validity itself is enforced at the tenants table's door (the
 * tenants_timezone_guard trigger) — a broken tenant can never be seeded,
 * so the per-tenant BEGIN…EXCEPTION block stands as defense-in-depth.
 *
 * Parity (AD-22): after the arms fire, every employee's TS verdict from
 * readDayStatusGrid + computeDayStatus over the SAME facts is compared
 * against the SQL's suppression decisions. The block only asserts when D
 * lands on the real today — the engine's isPast semantics bind to the DB's
 * clock, while the clock-driven arms run on the crafted date.
 *
 * NOTE on the live DB: the suite temporarily unschedules the
 * `attendance-run-reminders` pg_cron job (its own clock would otherwise
 * race the crafted p_now instants), and restores the EXACT stored
 * schedule + command in afterAll. Requires real credentials (gated like
 * the 18-1 spec). The fixture removes the throwaway tenants on any
 * seeding failure AND in afterAll.
 */
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { PgPoolFactory } from '../../src/common/pg/pg-pool.factory';
import { readDayStatusGrid } from '../../src/common/day-status/grid-reader';
import { computeDayStatus } from '../../src/common/day-status/day-status.model';

jest.setTimeout(120_000);

const DATABASE_URL = process.env['DATABASE_URL'] ?? '';
const IS_REAL_DB = DATABASE_URL !== '' && !DATABASE_URL.includes('test:test');

const TZ = 'Asia/Kolkata';
const OFF = '+05:30';

const TENANT = randomUUID();
const OWNER = randomUUID();
/** Tenant B (AD-14 loop arm) — completed setup with its own small facts. */
const BROKEN = randomUUID();
const B_OWNER = randomUUID();
const B_TECH = randomUUID();
/** Tenant C — complete enrolment facts, but setup never completed. */
const INCOMPLETE = randomUUID();
const C_OWNER = randomUUID();
const C_TECH = randomUUID();

const ist = (date: string, hms: string): string => `${date} ${hms}${OFF}`;
const dayOffset = (dateIso: string, n: number): string => {
  const [y, m, d] = dateIso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const isSunday = (dateIso: string): boolean =>
  new Date(`${dateIso}T00:00:00Z`).getUTCDay() === 0;
const nonSundayOnOrAfter = (dateIso: string): string =>
  isSunday(dateIso) ? dayOffset(dateIso, 1) : dateIso;
/** ISO weekday of the date (1=Mon..7=Sun — the weekly-off vocabulary). */
const isoDow = (dateIso: string): number => {
  const jsDow = new Date(`${dateIso}T00:00:00Z`).getUTCDay(); // 0=Sun
  return jsDow === 0 ? 7 : jsDow;
};

/** Named probe employees — every arm of FR-23's matrix. */
const E = {
  noCheckin: randomUUID(), // check-in arm at Start + cut-off (09:45)
  fullLeave: randomUUID(), // approved full-day leave → suppressed
  pendLeave: randomUUID(), // pending leave → arm fires; owner alerted
  halfLeave: randomUUID(), // approved first-half → due Midpoint + cut-off
  graded: randomUUID(), // complete record → no reminder, ever
  openLate: randomUUID(), // 09:56 check-in → checkout due 18:41
  punctual: randomUUID(), // 09:30 open check-in → checkout due 18:30
  adjudicated: randomUUID(), // status-only override → suppressed
  grace: randomUUID(), // enabled on D at 11:00, no check-in → grace_skip
  timesOnly: randomUUID(), // manual 07:00 check-in → checkout due 18:30
  secondHalf: randomUUID(), // approved second-half + check-in → due 14:00
  weeklyOff: randomUUID(), // weekly-off override covering D → suppressed
  noRule: randomUUID(), // office with no covering rule → OUT of facts
};
const ALL = Object.values(E);

let pool: Pool;
let pg: PgPoolFactory;
let today = '1970-01-01';
let D = '1970-01-01';
let D2 = '1970-01-01';
let officeId = '';
let rulelessOffice = '';
let ruleId = '';
/** Tenant B's office id (its summary reminder's dedupe-key suffix). */
let bOfficeId = '';
/** The reminder job's stored schedule/command (restored in afterAll). */
let storedJob: { schedule: string; command: string } | null = null;

/** One tick of the reminder job at the crafted instant. */
const tick = async (hms: string, date: string = D): Promise<void> => {
  await pool.query('select public.attendance_run_reminders($1::timestamptz)', [
    `${date} ${hms}${OFF}`,
  ]);
};

const reminderRows = async (): Promise<Record<string, unknown>[]> =>
  (
    await pool.query(
      `select event_type, dedupe_key, payload, user_id,
              entity_type, entity_id
         from public.notifications
        where tenant_id = $1
          and event_type in (
            'attendance.reminder_checkin',
            'attendance.reminder_checkout',
            'attendance.reminder_not_checked_in',
            'leave.pending_reminder')
        order by dedupe_key`,
      [TENANT],
    )
  ).rows as Record<string, unknown>[];

const keyOf = async (): Promise<string[]> =>
  (await reminderRows()).map((r) => String(r.dedupe_key));

/** The dedupe keys of a fetched reminder-row set. */
const dedupeKeys = (rows: Record<string, unknown>[]): string[] =>
  rows.map((r) => String(r.dedupe_key));

const keysSince = async (before: string[]): Promise<string[]> => {
  const keys = await keyOf();
  return keys.filter((k) => !before.includes(k));
};

/** Seeds a check-in/checkout record with its mandatory attempt rows. */
const seedRecord = async (
  employeeId: string,
  checkin: string,
  checkout: string | null,
): Promise<void> => {
  const attemptIn = (
    await pool.query<{ id: string }>(
      `insert into public.attendance_attempts
         (tenant_id, employee_id, request_id, kind, outcome, attempted_at, mocked)
       values ($1, $2, gen_random_uuid(), 'check_in', 'ok', $3, false) returning id`,
      [TENANT, employeeId, ist(D, checkin)],
    )
  ).rows[0].id;
  if (checkout === null) {
    await pool.query(
      `insert into public.attendance_records
         (tenant_id, employee_id, work_date, office_id, office_rules_id, radius_m,
          checkin_at, checkin_attempt_id, checkin_lat, checkin_lng,
          checkin_accuracy_m, checkin_distance_m, checkin_mocked)
       values ($1, $2, $3, $4, $5, 100, $6, $7, 12.97, 77.59, 10, 40, false)`,
      [TENANT, employeeId, D, officeId, ruleId, ist(D, checkin), attemptIn],
    );
    return;
  }
  const attemptOut = (
    await pool.query<{ id: string }>(
      `insert into public.attendance_attempts
         (tenant_id, employee_id, request_id, kind, outcome, attempted_at, mocked)
       values ($1, $2, gen_random_uuid(), 'check_out', 'ok', $3, false) returning id`,
      [TENANT, employeeId, ist(D, checkout)],
    )
  ).rows[0].id;
  await pool.query(
    `insert into public.attendance_records
       (tenant_id, employee_id, work_date, office_id, office_rules_id, radius_m,
        checkin_at, checkin_attempt_id, checkin_lat, checkin_lng,
        checkin_accuracy_m, checkin_distance_m, checkin_mocked,
        checkout_at, checkout_attempt_id, checkout_lat, checkout_lng,
        checkout_accuracy_m, checkout_distance_m, checkout_mocked)
     values ($1, $2, $3, $4, $5, 100, $6, $7, 12.97, 77.59, 10, 40, false,
             $8, $9, 12.97, 77.59, 10, 40, false)`,
    [
      TENANT, employeeId, D, officeId, ruleId,
      ist(D, checkin), attemptIn, ist(D, checkout), attemptOut,
    ],
  );
};

const leaveRequest = async (
  employeeId: string,
  part: string,
  seedState: string,
): Promise<void> => {
  const id = (
    await pool.query<{ id: string }>(
      `insert into public.leave_requests
         (tenant_id, employee_id, request_id, start_date, end_date, part, reason, created_by)
       values ($1, $2, gen_random_uuid(), $3, $3, $4, 'probe leave', $5) returning id`,
      [TENANT, employeeId, D, part, OWNER],
    )
  ).rows[0].id;
  await pool.query(
    `insert into public.leave_request_days
       (tenant_id, leave_request_id, employee_id, leave_date, state)
     values ($1, $2, $3, $4, $5)`,
    [TENANT, id, employeeId, D, seedState],
  );
};

const seedScaffold = async (): Promise<void> => {
  await pool.query('begin');
  // Each tenant carries its OWN owner user — tenants.owner_id is unique.
  const probeUsers = [OWNER, B_OWNER, C_OWNER, ...ALL, B_TECH, C_TECH];
  await pool.query(
    `insert into public.users (id, name, role, status, country_code, phone_number)
     select u, '19-1 probe person', 'technician', 'active', '+91', ph
       from unnest($1::uuid[], $2::text[]) as t(u, ph)`,
    [probeUsers, probeUsers.map((_, i) => String(930000000 + (Date.now() % 50_000_000) + i))],
  );
  await pool.query(
    `insert into public.tenants (id, owner_id, company_name, state_code, timezone)
     values ($1, $2, $3, 'KA', $4),
            ($5, $6, $7, 'KA', $4)`,
    [TENANT, OWNER, `epic-19 probe reminder ${TENANT.slice(0, 8)}`, TZ,
      INCOMPLETE, C_OWNER, `epic-19 probe incomplete ${INCOMPLETE.slice(0, 8)}`],
  );
  await pool.query(
    `insert into public.attendance_settings (tenant_id, enabled, setup_completed_at)
     values ($1, true, now()), ($2, true, null)`,
    [TENANT, INCOMPLETE],
  );
  await pool.query(
    'update public.users set tenant_id = $1 where id = any($2::uuid[])',
    [TENANT, [OWNER, ...ALL]],
  );
  await pool.query(
    "update public.users set role = 'owner' where id = any($1::uuid[])",
    [[OWNER, B_OWNER, C_OWNER]],
  );

  // The crafted probe date: a non-Sunday inside every validity window (the
  // whole suite is anchored on it, independent of the day it runs on).
  today = (
    await pool.query<{ today: string }>(
      'select (now() at time zone $1)::date::text as today',
      [TZ],
    )
  ).rows[0].today;
  D = nonSundayOnOrAfter(today);
  D2 = nonSundayOnOrAfter(dayOffset(D, 1));

  // Tenant B (AD-14's loop arm): the same owner runs a SECOND completed
  // tenant with its own facts, so its reminder arms fire in the same
  // ticks as the first tenant's — independent fan-out, per-tenant keys.
  await pool.query(
    `insert into public.tenants (id, owner_id, company_name, state_code, timezone)
     values ($1, $2, $3, 'KA', $4)`,
    [BROKEN, B_OWNER, `epic-19 probe tenant-b ${BROKEN.slice(0, 8)}`, TZ],
  );
  await pool.query(
    `insert into public.attendance_settings (tenant_id, enabled, setup_completed_at)
     values ($1, true, now())`,
    [BROKEN],
  );
  await pool.query(
    'update public.users set tenant_id = $1 where id = $2',
    [BROKEN, B_TECH],
  );
  bOfficeId = (
    await pool.query<{ id: string }>(
      `insert into public.attendance_offices (tenant_id, name, latitude, longitude, radius_m)
       values ($1, 'B office', 12.9716, 77.5946, 100) returning id`,
      [BROKEN],
    )
  ).rows[0].id;
  await pool.query(
    `insert into public.attendance_office_rules
       (office_id, tenant_id, valid, start_time, end_time,
        late_cutoff_minutes, full_day_hours, half_day_hours)
     select o.id, o.tenant_id, daterange(current_date - 60, current_date + 120),
            '09:30', '18:30', 15, 8, 4
       from public.attendance_offices o
      where o.tenant_id = $1 and o.name = 'B office'`,
    [BROKEN],
  );
  await pool.query(
    `insert into public.attendance_office_assignments (tenant_id, employee_id, office_id, valid)
     select $1, $2, o.id, daterange(current_date - 60, current_date + 120)
       from public.attendance_offices o
      where o.tenant_id = $1 and o.name = 'B office'`,
    [BROKEN, B_TECH],
  );
  await pool.query(
    `insert into public.attendance_enrolments (tenant_id, employee_id, valid, enabled_at)
     values ($1, $2, daterange(current_date - 60, current_date + 120), $3)`,
    [BROKEN, B_TECH, ist(dayOffset(today, -60), '00:00:00')],
  );
  // Tenant C mirrors a complete reminder surface (user + assignment + rule
  // + enrolment) — ONLY the setup gate differs, so its absence from the
  // notifications is the AD-25 gate's doing, not an empty fixture's.
  await pool.query(
    'update public.users set tenant_id = $1 where id = $2',
    [INCOMPLETE, C_TECH],
  );
  await pool.query(
    `insert into public.attendance_offices (tenant_id, name, latitude, longitude, radius_m)
     values ($1, 'C office', 12.9716, 77.5946, 100)`,
    [INCOMPLETE],
  );
  await pool.query(
    `insert into public.attendance_office_rules
       (office_id, tenant_id, valid, start_time, end_time,
        late_cutoff_minutes, full_day_hours, half_day_hours)
     select o.id, o.tenant_id, daterange(current_date - 60, current_date + 120),
            '09:30', '18:30', 15, 8, 4
       from public.attendance_offices o
      where o.tenant_id = $1 and o.name = 'C office'`,
    [INCOMPLETE],
  );
  await pool.query(
    `insert into public.attendance_office_assignments (tenant_id, employee_id, office_id, valid)
     select $1, $2, o.id, daterange(current_date - 60, current_date + 120)
       from public.attendance_offices o
      where o.tenant_id = $1 and o.name = 'C office'`,
    [INCOMPLETE, C_TECH],
  );
  await pool.query(
    `insert into public.attendance_enrolments (tenant_id, employee_id, valid, enabled_at)
     values ($1, $2, daterange(current_date - 60, current_date + 120), $3)`,
    [INCOMPLETE, C_TECH, ist(dayOffset(today, -60), '00:00:00')],
  );

  officeId = (
    await pool.query<{ id: string }>(
      `insert into public.attendance_offices (tenant_id, name, latitude, longitude, radius_m)
       values ($1, 'HQ', 12.9716, 77.5946, 100) returning id`,
      [TENANT],
    )
  ).rows[0].id;
  rulelessOffice = (
    await pool.query<{ id: string }>(
      `insert into public.attendance_offices (tenant_id, name, latitude, longitude, radius_m)
       values ($1, 'ruleless', 12.9716, 77.5946, 100) returning id`,
      [TENANT],
    )
  ).rows[0].id;
  ruleId = (
    await pool.query<{ id: string }>(
      `insert into public.attendance_office_rules
         (office_id, tenant_id, valid, start_time, end_time,
          late_cutoff_minutes, full_day_hours, half_day_hours)
       values ($1, $2, daterange(current_date - 60, current_date + 120),
               '09:30', '18:30', 15, 8, 4) returning id`,
      [officeId, TENANT],
    )
  ).rows[0].id;

  for (const employeeId of ALL) {
    await pool.query(
      `insert into public.attendance_office_assignments
         (tenant_id, employee_id, office_id, valid)
       values ($1, $2, $3, daterange(current_date - 60, current_date + 120))`,
      [TENANT, employeeId,
        employeeId === E.noRule ? rulelessOffice : officeId],
    );
    await pool.query(
      `insert into public.attendance_enrolments (tenant_id, employee_id, valid, enabled_at)
       values ($1, $2, daterange(current_date - 60, current_date + 120), $3)`,
      [TENANT, employeeId,
        employeeId === E.grace ? ist(D, '11:00:00')
          : ist(dayOffset(today, -60), '00:00:00')],
    );
  }

  // Weekly-off facts: the tenant default is Sunday; the override REPLACES
  // it for the weeklyOff probe employee on D (per-employee, keyed by the
  // ISO weekday — the pickWeeklyOffDays contract).
  await pool.query(
    `insert into public.attendance_weekly_off_defaults (tenant_id, valid, days)
     values ($1, daterange(current_date - 60, current_date + 120), '{7}'::int[])`,
    [TENANT],
  );
  await pool.query(
    `insert into public.attendance_weekly_off_overrides (tenant_id, employee_id, valid, days)
     values ($1, $2, daterange(current_date - 60, current_date + 120), $3::int[])`,
    [TENANT, E.weeklyOff, [isoDow(D)]],
  );
  await pool.query(
    `insert into public.holidays (tenant_id, holiday_date, name)
     values ($1, $2, 'probe holiday')`,
    [TENANT, D2],
  );

  // ---- records (every check-in needs its attempt row) --------------------
  await seedRecord(E.graded, '09:30:00', '18:30:00'); // complete → silent
  await seedRecord(E.openLate, '09:56:00', null); // late 11 → due 18:41
  await seedRecord(E.punctual, '09:30:00', null); // late 0 → due 18:30
  await seedRecord(E.secondHalf, '09:30:00', null); // due Midpoint + 0

  // ---- leave: approved full-day (suppresses) + pending (never suppresses)
  // + the two approved halves that SHIFT their reminders --------------------
  await leaveRequest(E.fullLeave, 'full_day', 'approved');
  await leaveRequest(E.pendLeave, 'full_day', 'pending');
  await leaveRequest(E.halfLeave, 'first_half', 'approved');
  await leaveRequest(E.secondHalf, 'second_half', 'approved');

  // ---- overrides: an owner adjudication + a manual-instant day -----------
  await pool.query(
    `insert into public.attendance_day_overrides
       (tenant_id, employee_id, work_date, status, created_by)
     values ($1, $2, $3, 'absent', $4)`,
    [TENANT, E.adjudicated, D, OWNER],
  );
  await pool.query(
    `insert into public.attendance_day_overrides
       (tenant_id, employee_id, work_date, manual_checkin_at, created_by)
     values ($1, $2, $3, $4, $5)`,
    [TENANT, E.timesOnly, D, ist(D, '07:00:00'), OWNER],
  );

  await pool.query('commit');
};

const teardownTenants = async (): Promise<void> => {
  const allTenants = [TENANT, BROKEN, INCOMPLETE];
  // notifications carry no FK (no cascade) — deleted explicitly first, for
  // all three probe tenants and by the owner's uuid as a name-pattern net.
  await pool.query(
    'delete from public.notifications where tenant_id = any($1::uuid[])',
    [allTenants],
  );
  await pool.query(
    'delete from public.leave_request_days where tenant_id = any($1::uuid[])',
    [allTenants],
  );
  await pool.query(
    'delete from public.leave_events where tenant_id = any($1::uuid[])',
    [allTenants],
  );
  await pool.query(
    'delete from public.leave_requests where tenant_id = any($1::uuid[])',
    [allTenants],
  );
  await pool.query(
    'delete from public.attendance_corrections where tenant_id = any($1::uuid[])',
    [allTenants],
  );
  await pool.query(
    'delete from public.attendance_day_overrides where tenant_id = any($1::uuid[])',
    [allTenants],
  );
  await pool.query(
    'delete from public.attendance_records where tenant_id = any($1::uuid[])',
    [allTenants],
  );
  await pool.query(
    'delete from public.attendance_attempts where tenant_id = any($1::uuid[])',
    [allTenants],
  );
  // enrolments + assignments go in ONE statement — the coverage trigger is
  // immediate statement-level on both tables (the 18-1 probe's G2 finding).
  await pool.query(
    `with gone as (
       delete from public.attendance_enrolments where tenant_id = any($1::uuid[]) returning 1
     )
     delete from public.attendance_office_assignments where tenant_id = any($1::uuid[])`,
    [allTenants],
  );
  // The weekly-off surfaces RESTRICT user deletes (their composite FKs
  // reference users (id, tenant_id)) — they go before the users.
  await pool.query(
    'delete from public.attendance_weekly_off_overrides where tenant_id = any($1::uuid[])',
    [allTenants],
  );
  await pool.query(
    'delete from public.attendance_weekly_off_defaults where tenant_id = any($1::uuid[])',
    [allTenants],
  );
  await pool.query(
    `delete from public.users
      where tenant_id = any($1::uuid[]) or id = any($2::uuid[])`,
    [allTenants, [OWNER, B_OWNER, C_OWNER, ...ALL, B_TECH, C_TECH]],
  );
  await pool.query(
    `delete from public.tenants
      where id = any($1::uuid[]) or company_name like 'epic-19 probe%'`,
    [allTenants],
  );
  const residual = await pool.query<{ n: string }>(
    `select coalesce(sum(n), 0)::text as n from (
       select count(*) n from public.notifications
         where tenant_id = any($1::uuid[]) or user_id = any($1::uuid[])
       union all
       select count(*) n from public.attendance_records where tenant_id = any($1::uuid[])
       union all
       select count(*) n from public.attendance_day_overrides where tenant_id = any($1::uuid[])
       union all
       select count(*) n from public.attendance_attempts where tenant_id = any($1::uuid[])
       union all
       select count(*) n from public.leave_request_days where tenant_id = any($1::uuid[])
       union all
       select count(*) n from public.tenants where company_name like 'epic-19 probe%'
     ) s`,
    [allTenants],
  );
  expect(residual.rows[0].n).toBe('0');
};

describe('attendance_run_reminders journey (19-1, real DB)', () => {
  const maybeIt = IS_REAL_DB ? it : it.skip;

  beforeAll(async () => {
    if (!IS_REAL_DB) return;
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 2,
    });
    pg = new PgPoolFactory({
      getOrThrow: (k: string) => {
        const v = process.env[k];
        if (!v) throw new Error(`missing config key ${k}`);
        return v;
      },
    } as never);
    // Pause the LIVE reminder job for the suite's run — its own DB-clock
    // ticks would race the crafted p_now instants (the probe's seeded date
    // D must be the real today for the parity block). The stored schedule
    // + command are restored EXACTLY in afterAll.
    storedJob = (
      await pool.query<{ schedule: string; command: string }>(
        `select schedule, command from cron.job
          where jobname = 'attendance-run-reminders' limit 1`,
      )
    ).rows[0] ?? null;
    if (storedJob) {
      await pool.query(
        "select cron.unschedule('attendance-run-reminders')",
      );
    }
    try {
      await seedScaffold();
    } catch (e) {
      await teardownTenants();
      throw e;
    }
  });

  afterAll(async () => {
    if (!IS_REAL_DB) return;
    try {
      // Restore the REMINDER job first (never leave the tenant's reminders
      // off over a teardown failure), then remove the fixture children-first.
      if (storedJob) {
        await pool.query('select cron.schedule($1, $2, $3)', [
          'attendance-run-reminders',
          storedJob.schedule,
          storedJob.command,
        ]);
        storedJob = null;
      }
      await teardownTenants();
    } finally {
      await pool.end();
    }
  });

  maybeIt('an 08:00 tick fires NOTHING — before every due instant', async () => {
    await tick('08:00:00');
    expect(await reminderRows()).toEqual([]);
  });

  maybeIt('the 12:00 tick fires the check-in, summary, and pending arms', async () => {
    await tick('12:00:00');
    const rows = await reminderRows();
    expect(rows).toHaveLength(4);
    const keys = new Set(dedupeKeys(rows));
    expect(keys).toEqual(new Set([
      `${TENANT}:attendance.reminder_checkin:${E.noCheckin}:${D}`,
      `${TENANT}:attendance.reminder_checkin:${E.pendLeave}:${D}`,
      `${TENANT}:attendance.reminder_not_checked_in:${OWNER}:${D}:${officeId}`,
      `${TENANT}:leave.pending_reminder:${OWNER}:${D}`,
    ]));
    // Payloads + recipients + deep-link pairs exactly as the AD-13
    // registry and notifications_entity_pair_chk pin them: employee
    // reminders carry an all-set attendance pair, the tenant-wide
    // pending digest carries an all-NULL pair.
    for (const row of rows) {
      switch (row['event_type']) {
        case 'attendance.reminder_checkin':
          expect(row['payload']).toEqual({ workDate: D });
          expect(row['user_id']).toBe(
            String(row['dedupe_key']).split(':')[2],
          );
          expect(row['entity_type']).toBe('attendance');
          expect(row['entity_id']).toBe(
            String(row['dedupe_key']).split(':')[2],
          );
          break;
        case 'attendance.reminder_not_checked_in':
          expect(row['payload']).toEqual({
            officeName: 'HQ',
            notCheckedInCount: 3, // noCheckin + pendLeave + halfLeave
            workDate: D,
          });
          expect(row['user_id']).toBe(OWNER);
          expect(row['dedupe_key']).toContain(`:${officeId}`);
          expect(row['entity_type']).toBe('attendance');
          expect(row['entity_id']).toBe(officeId);
          break;
        case 'leave.pending_reminder':
          expect(row['payload']).toEqual({ pendingCount: 1 });
          expect(row['user_id']).toBe(OWNER);
          expect(row['entity_type']).toBeNull();
          expect(row['entity_id']).toBeNull();
          break;
      }
    }
  });

  maybeIt('an idempotent re-run absorbs every already-due arm', async () => {
    await tick('13:00:00');
    // The same 4 rows, zero new — ON CONFLICT DO NOTHING on the dedupe key.
    expect(dedupeKeys(await reminderRows())).toHaveLength(4);
  });

  maybeIt('the two shifted half-day arms fire at their OWN instants', async () => {
    const before = await keyOf();
    // The approved second-half check-out is due at Midpoint + late = 14:00
    // (its late minutes being 0) — the ONLY arm at this tick.
    await tick('14:00:00');
    expect(await keysSince(before)).toEqual([
      `${TENANT}:attendance.reminder_checkout:${E.secondHalf}:${D}`,
    ]);
    // B-BUG-1 boundary: a tick ONE SECOND before a due instant must fire
    // NOTHING. PG's rounding `::int` cast read 14:29:59 as the 14:30
    // threshold minute and fired the displaced first-half check-in early
    // (bug-bash 2026-10-02, live-proven at 09:14:59 vs a 09:15:00
    // threshold); the floor()ed clock must hold the second back.
    const beforePre = await keyOf();
    await tick('14:29:59');
    expect(await keysSince(beforePre)).toEqual([]);
    // The displaced first-half check-in is due at Midpoint + cut-off =
    // 14:15 — a full tick later, the two arms can never collide.
    const before1430 = await keyOf();
    await tick('14:30:00');
    expect(await keysSince(before1430)).toEqual([
      `${TENANT}:attendance.reminder_checkin:${E.halfLeave}:${D}`,
    ]);
  });

  maybeIt('a late check-in shifts its check-out reminder by its own lateness', async () => {
    const before = await keyOf();
    await tick('18:00:00'); // due 18:30 for the punctual pair, 18:41 for 09:56
    expect(await keysSince(before)).toEqual([]);
    await tick('18:30:00');
    const at1830 = await keysSince(before);
    expect([...at1830].sort()).toEqual([
      `${TENANT}:attendance.reminder_checkout:${E.punctual}:${D}`,
      `${TENANT}:attendance.reminder_checkout:${E.timesOnly}:${D}`,
    ].sort());
    // late = 0 → due exactly at Expected end (the 2026-09-29 ruling); the
    // 09:56 employee's due (18:41) fires at the next 5-minute tick after.
    const before1845 = await keyOf();
    await tick('18:45:00');
    expect(await keysSince(before1845)).toEqual([
      `${TENANT}:attendance.reminder_checkout:${E.openLate}:${D}`,
    ]);
    await tick('18:50:00');
    // The whole day's keyspace is final and absorbed: 3 check-ins + 4
    // check-outs + 1 office summary + 1 pending alert = 9, and this
    // re-run (the cron's real cadence) adds nothing — the dedupe key IS
    // the idempotency guarantee.
    expect((await reminderRows()).length).toBe(9);
  });

  maybeIt('a tenant holiday suppresses every employee arm, not the pending alert', async () => {
    const before = await keyOf();
    await tick('12:00:00', D2);
    const gained = await keysSince(before);
    expect(gained).toEqual([
      `${TENANT}:leave.pending_reminder:${OWNER}:${D2}`,
    ]);
  });

  maybeIt('a second tenant fires its OWN arms in the same ticks; the gated one stays silent (AD-14/AD-25)', async () => {
    // Tenant B is a fully-completed tenant with its own tiny facts (one
    // tracked employee, no records): its check-in + summary arms fire for
    // B_TECH in the SAME ticks as the first tenant's, keyed per tenant —
    // zero cross-leakage. (NOTE: this test previously asserted B stays at
    // zero rows — that was written for the old broken-timezone fixture;
    // with B redesigned as a valid tenant the requirement it now pins is
    // the OPPOSITE: B MUST have fired, or the per-tenant loop died.)
    // Tenant C has complete facts but never completes setup → the AD-25
    // gate keeps it notification-less.
    const brokenRows = await pool.query<{ dk: string }>(
      `select dedupe_key as dk
         from public.notifications
        where tenant_id = $1
          and event_type in (
            'attendance.reminder_checkin',
            'attendance.reminder_not_checked_in')
        order by dedupe_key`,
      [BROKEN],
    );
    expect(brokenRows.rows.map((r) => r.dk)).toEqual([
      `${BROKEN}:attendance.reminder_checkin:${B_TECH}:${D}`,
      `${BROKEN}:attendance.reminder_checkin:${B_TECH}:${D2}`,
      `${BROKEN}:attendance.reminder_not_checked_in:${B_OWNER}:${D}:${bOfficeId}`,
      `${BROKEN}:attendance.reminder_not_checked_in:${B_OWNER}:${D2}:${bOfficeId}`,
    ]);
    // The deep-link pairs are all-set for employee/summary reminders
    // (AD-13) — the pending digest (if it existed here) is the only
    // pair-less notification.
    const pairs = await pool.query<{ et: string; ety: string | null; eid: string | null }>(
      `select event_type as et,
              entity_type as ety,
              entity_id   as eid,
              dedupe_key  as dk
         from public.notifications
        where tenant_id = $1
          and event_type like 'attendance.reminder%'
        order by dedupe_key`,
      [BROKEN],
    );
    for (const row of pairs.rows) {
      expect(row.ety).toBe('attendance');
      if (
        String(row.dk).startsWith(
          `${BROKEN}:attendance.reminder_checkin:${B_TECH}`,
        )
      ) {
        expect(row.eid).toBe(B_TECH);
      } else {
        expect(row.eid).toBe(bOfficeId); // the office summary's target
      }
    }
    const stray = await pool.query<{ n: string }>(
      'select count(*)::text as n from public.notifications where tenant_id = $1',
      [INCOMPLETE],
    );
    expect(stray.rows[0].n).toBe('0');
  });

  maybeIt('AD-22 parity — the TS engine over the same facts agrees with the SQL arms', async () => {
    if (D !== today) return; // the engine's isPast binds to the real today
    const grid = await pg.withTransaction((tx) =>
      readDayStatusGrid(tx, TENANT, ALL, D, D),
    );
    const status = new Map(
      grid.map((r) => [r.employeeId, computeDayStatus(r).status] as const),
    );
    // The complete record grades present (rule 7).
    expect(status.get(E.graded)).toBe('present');
    // Today's open days are in progress (rule 10) — the SQL's checkout arms
    // fire for exactly the open-check-in population.
    for (const employeeId of [E.punctual, E.openLate, E.timesOnly, E.secondHalf]) {
      expect(status.get(employeeId)).toBe('in_progress');
    }
    // The SQL's check-in reminders minus the sanctioned displaced
    // first-half shift (its TS status stays 'leave' — the 14:30 arm
    // test pins the shift itself) are exactly the TS
    // not_checked_in_yet rows minus the rule-less employee: AD-22
    // drops no-rule employees from the SQL facts entirely (no rule →
    // no thresholds to be late against), while the TS read model
    // grades such a day permissively as not_checked_in_yet (the 18-2
    // setup-gap fallback the grid warns about). Pending leave
    // suppresses nothing on either side (its day reads as still open).
    const checkinRecipients = dedupeKeys(await reminderRows())
      .filter((k) => k.includes(':attendance.reminder_checkin:'))
      .map((k) => k.split(':')[2])
      .filter((id) => id !== E.halfLeave);
    const notCheckedInYet = grid
      .filter((r) => computeDayStatus(r).status === 'not_checked_in_yet')
      .map((r) => r.employeeId)
      .filter((id) => id !== E.noRule);
    expect([...checkinRecipients].sort()).toEqual([...notCheckedInYet].sort());
    // The engine's status vocabulary for an approved half-day leave with
    // no work record is half_day_leave (plain 'leave' is full-day) — the
    // shift's reminder fires SQL-side at Midpoint + cut-off regardless.
    expect(status.get(E.halfLeave)).toBe('half_day_leave');
    // The SQL's suppression set — every arm's else-branch is a TS status:
    // the approved full-day leave (leave), the adjudication (absent), the
    // grace window (not_tracked), and the weekly-off override (weekly_off).
    // The rule-less office is NOT in the SQL facts at all (AD-22: no rule
    // → no thresholds), and its TS grade is not_checked_in_yet — the 18-2
    // read model's designed permissive setup-gap fallback (the grid warns
    // "no covering office rule" above) — hence the parity subtraction.
    expect(status.get(E.fullLeave)).toBe('leave');
    expect(status.get(E.adjudicated)).toBe('absent');
    expect(status.get(E.grace)).toBe('not_tracked');
    expect(status.get(E.noRule)).toBe('not_checked_in_yet');
    expect(status.get(E.weeklyOff)).toBe('weekly_off');
  });
});
