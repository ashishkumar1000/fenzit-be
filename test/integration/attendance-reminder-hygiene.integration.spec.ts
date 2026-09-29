/**
 * 19-1's pg_cron hygiene probes (NFR-9 / AD-26, real DB).
 *
 * The reminders' cron plumbing lives in migration 20260929000004's tail:
 * three scheduled jobs whose commands this spec executes DIRECTLY (read
 * from `cron.job` — the DB is the source of truth, never a copy of the
 * SQL in the test):
 *  - `cron-job-run-details-cleanup` (job 2) — prunes pg_cron's own run
 *    log past 7 days, keeping the gauge's 24-hour input bounded by design.
 *  - `attendance-attempts-coordinate-cleanup` (job 3) — AD-26's 90-day
 *    coordinate prune: coordinates on rejected attempts (outcome <> 'ok')
 *    are nulled; outcome='ok' rows are NEVER touched (the record's
 *    coordinates are its dispute value; 20260928000002's outcome CHECK
 *    makes 'ok' exactly the accepted arm).
 *  - `attendance-run-reminders` (job 1) — the reminders themselves; the
 *    8/8 journey spec (attendance-reminders.integration.spec.ts) covers
 *    their SQL, so only the registration shape is pinned here.
 *
 * Every probe reads the stored `command` text out of `cron.job` and
 * executes IT — a changed command fails here even if a stale local copy
 * would still pass. Requires real credentials like the other probes;
 * fixtures are self-contained and removed in afterAll.
 */
import { Pool } from 'pg';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { PgPoolFactory } from '../../src/common/pg/pg-pool.factory';
import { ReminderJobMetricsBinder } from '../../src/attendance/reminder-metrics';
import {
  REMINDER_JOB_GAUGE_SQL,
  getReminderJobMetricQuery,
} from '../../src/telemetry/app-metrics';

const DATABASE_URL = process.env['DATABASE_URL'] ?? '';
const SUPABASE_URL = process.env['SUPABASE_URL'] ?? '';
const SUPABASE_SERVICE_ROLE_KEY =
  process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';
const IS_REAL_DB =
  DATABASE_URL !== '' &&
  !DATABASE_URL.includes('test:test') &&
  SUPABASE_URL !== '' &&
  !SUPABASE_URL.includes('test.supabase.co');

const TENANT = randomUUID();
const OWNER = randomUUID();
const EMPLOYEE = randomUUID();
const PROBE_PHONE = `7${Date.now()}`.slice(-10).replace(/^./, '7') + '5';

interface CronJobRow {
  jobid: number;
  jobname: string;
  schedule: string;
  command: string;
}

jest.setTimeout(120_000);

describe('Reminder cron hygiene (19-1, real DB)', () => {
  const maybeIt = IS_REAL_DB ? it : it.skip;
  let pool: Pool;
  let admin: SupabaseClient;
  let probesJobId: number;
  /** start_time stamps of our seeded job_run_details rows (the delete key). */
  let seededRunStarts: string[] = [];
  /** attempted_at stamps of our seeded attempts (none — cascade removes). */

  beforeAll(async () => {
    if (!IS_REAL_DB) return;
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 2,
    });
    admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Fixture: one owner (tenant-less first — tenants.owner_id references
    // it), the throwaway tenant, then the technician (attempts FK to
    // users(id, tenant_id); the 20260928000002 composite shape).
    await admin.from('users').insert({
      id: OWNER,
      role: 'owner',
      status: 'active',
      country_code: '+91',
      phone_number: PROBE_PHONE,
      name: '19-1 hygiene probe owner',
    });
    const r = await pool.query(
      `insert into public.tenants (id, owner_id, company_name, state_code,
                                    timezone)
       values ($1, $2, '19-1 hygiene probe', 'KA', 'Asia/Kolkata')
       returning id::text as id`,
      [TENANT, OWNER],
    );
    if (r.rows.length === 0) throw new Error('fixture tenant insert failed');
    await admin.from('users').insert({
      id: EMPLOYEE,
      tenant_id: TENANT,
      role: 'technician',
      status: 'active',
      country_code: '+91',
      phone_number: PROBE_PHONE.replace(/.$/, '6'),
      name: '19-1 hygiene probe tech',
    });
  });

  afterAll(async () => {
    if (!IS_REAL_DB) return;
    // Our seeded run-details rows are NOT the live cron's — remove exactly
    // the ones this spec inserted (start_time-keyed; the live reminders
    // cadence keeps writing rows for the same jobid, so never by jobid).
    if (seededRunStarts.length > 0 && probesJobId !== undefined) {
      await pool.query(
        `delete from cron.job_run_details where jobid = $1 and start_time = any($2)`,
        [probesJobId, seededRunStarts],
      );
    }
    await admin.from('tenants').delete().eq('id', TENANT);
    await pool.query(
      `delete from public.users where phone_number = any($1)`,
      [[PROBE_PHONE, PROBE_PHONE.replace(/.$/, '6')]],
    );
    await pool.end();
  });

  maybeIt('the three reminder jobs are registered with the ratified names, schedules and commands', async () => {
    const { rows } = await pool.query<{ jobs: CronJobRow[] }>(
      `select
         jsonb_agg(t order by t.jobname) as jobs
       from (
         select jobid::int as jobid, jobname, schedule, command
         from cron.job
         where jobname in (
           'attendance-run-reminders',
           'cron-job-run-details-cleanup',
           'attendance-attempts-coordinate-cleanup'
         )
       ) t`,
    );
    const jobs = rows[0].jobs ?? [];
    expect(jobs).toHaveLength(3);
    const byName = new Map(jobs!.map((j) => [j.jobname, j] as const));
    // Job 1: the reminders, every 5 minutes (AD-14), calling the single
    // clock-seamed function with NO argument (the p_now NULL default).
    const job1 = byName.get('attendance-run-reminders');
    expect(job1?.schedule).toBe('*/5 * * * *');
    expect(job1?.command).toBe('select public.attendance_run_reminders()');
    // Job 2: its own log prune, bounded (AD-26).
    const job2 = byName.get('cron-job-run-details-cleanup');
    expect(job2?.schedule).toBe('0 3 * * *');
    expect(job2?.command).toContain('delete from cron.job_run_details');
    expect(job2?.command).toContain("interval '7 days'");
    // Job 3: the 90-day coordinate prune, rejected arms only.
    const job3 = byName.get('attendance-attempts-coordinate-cleanup');
    expect(job3?.schedule).toBe('10 3 * * *');
    expect(job3?.command).toContain('update public.attendance_attempts');
    expect(job3?.command).toContain("interval '90 days'");
    expect(job3?.command).toContain("outcome <> 'ok'");
    probesJobId = Number(job1?.jobid);
  });

  maybeIt('job 2 prunes job_run_details past 7 days and keeps fresh rows', async () => {
    const {
      rows: [{ command, jobid }],
    } = await pool.query<CronJobRow[]>(
      `select jobid, command from cron.job
       where jobname = 'cron-job-run-details-cleanup'`,
    );
    const jobidBig = Number(jobid);
    const staleStart = new Date(Date.now() - 10 * 86_400_000);
    const freshStart = new Date(Date.now() - 1 * 86_400_000);
    seededRunStarts = [staleStart.toISOString(), freshStart.toISOString()];
    // runid supplied EXPLICITLY: the probe role cannot read cron's
    // runid_seq, and our rows must not collide with the live cadence's
    // (jobid, runid) rows for this jobid — off-sequence, time-derived IDs.
    const offSequence = (offset: number): number =>
      8_500_000_000_000 + (Date.now() % 100_000_000) + offset;
    await pool.query(
      `insert into cron.job_run_details (jobid, runid, status, start_time, end_time)
       values
         ($1, $4, 'succeeded', $2, $2),
         ($1, $5, 'succeeded', $3, $3)`,
      [
        jobidBig,
        staleStart,
        freshStart,
        offSequence(1),
        offSequence(2),
      ],
    );

    // Execute the STORED command (never a local copy).
    await pool.query(command);

    const { rows } = await pool.query<{ start_time: Date }>(
      `select start_time from cron.job_run_details
       where jobid = $1 and start_time in ($2::timestamptz, $3::timestamptz)`,
      [jobidBig, seededRunStarts[0], seededRunStarts[1]],
    );
    const survivors = rows.map((r) => r.start_time.toISOString());
    expect(survivors).toHaveLength(1);
    expect(survivors[0]).toBe(freshStart.toISOString());
  });

  maybeIt('job 3 nulls coordinates of >90d rejected attempts; keeps fresh and ok rows intact', async () => {
    const {
      rows: [{ command }],
    } = await pool.query<CronJobRow[]>(
      `select command from cron.job
       where jobname = 'attendance-attempts-coordinate-cleanup'`,
    );
    const old = new Date(Date.now() - 91 * 86_400_000).toISOString();
    const fresh = new Date(Date.now() - 2 * 86_400_000).toISOString();
    // Four rows, each with its own request_id (the per-row identity):
    // old rejected (mocked + too_far — both NON-'ok' arms), a fresh
    // rejected, and an old ACCEPTED ('ok') arm.
    const reqOldMocked = randomUUID();
    const reqOldTooFar = randomUUID();
    const reqFreshMocked = randomUUID();
    const reqOldOk = randomUUID();
    await pool.query(
      `insert into public.attendance_attempts
         (tenant_id, employee_id, request_id, kind, outcome,
          latitude, longitude, accuracy_m, distance_m, radius_m, mocked,
          attempted_at)
       values
         ($1, $2, $3,  'check_in', 'mocked',   12.97, 77.59, 12.0, 30, 100, true,  $5),
         ($1, $2, $4,  'check_in', 'too_far',  12.98, 77.60, 50.0, 800, 100, null, $5),
         ($1, $2, $6,  'check_in', 'mocked',   12.99, 77.61, 10.0, 40, 100, true, $7),
         ($1, $2, $8,  'check_in', 'ok',       12.96, 77.58, 8.0,  2,  100, null, $5)`,
      [TENANT, EMPLOYEE, reqOldMocked, reqOldTooFar, old, reqFreshMocked, new Date().toISOString(), reqOldOk],
    );

    // Execute the STORED command (never a local copy).
    await pool.query(command);

    const { rows } = await pool.query(
      `select request_id, outcome, latitude, longitude, accuracy_m
       from public.attendance_attempts
       where tenant_id = $1`,
      [TENANT],
    );
    expect(rows).toHaveLength(4);
    const pick = (requestId: string) =>
      rows.find((r) => r.request_id === requestId) as {
        latitude: number | null;
        longitude: number | null;
        accuracy_m: number | null;
        outcome: string;
      };
    // Old rejected arms are nulled — ALL THREE coordinate columns.
    for (const req of [reqOldMocked, reqOldTooFar]) {
      const row = pick(req);
      expect(row.latitude).toBeNull();
      expect(row.longitude).toBeNull();
      expect(row.accuracy_m).toBeNull();
    }
    // A fresh rejected attempt keeps its coordinates (inside 90 days).
    const freshRow = pick(reqFreshMocked);
    expect(freshRow.latitude).toBe(12.99);
    // The accepted arm is NEVER touched — its coordinates are the record's
    // dispute value (AD-26), whatever its age.
    const okRow = pick(reqOldOk);
    expect(okRow.latitude).toBe(12.96);
    expect(okRow.longitude).toBe(77.58);
    expect(okRow.accuracy_m).toBe(8.0);
  });

  maybeIt('the NFR-9 gauge SQL reads the binder seam and returns the reminders sample', async () => {
    const config = {
      getOrThrow: (key: string) => {
        if (key === 'DATABASE_URL') return DATABASE_URL;
        throw new Error(`Unexpected config key ${key}`);
      },
    } as unknown as ConfigService;
    const binder = new ReminderJobMetricsBinder(new PgPoolFactory(config));
    binder.onModuleInit();
    const query = getReminderJobMetricQuery();
    expect(query).not.toBeNull();

    // A run row inside the 24-hour window, then the exported SQL through
    // the registered seam — the exact production read.
    const recentStart = new Date(Date.now() - 30 * 60_000);
    const recentEnd = new Date(Date.now() - 25 * 60_000);
    seededRunStarts.push(recentStart.toISOString());
    // runid explicit — same off-sequence reasoning as the job-2 probe.
    await pool.query(
      `insert into cron.job_run_details (jobid, runid, status, start_time, end_time)
       values ($1, $2, 'succeeded', $3, $4)`,
      [
        probesJobId,
        8_500_000_000_000 + (Date.now() % 100_000_000) + 3,
        recentStart,
        recentEnd,
      ],
    );
    const rows = await query!(REMINDER_JOB_GAUGE_SQL);
    expect(rows).toHaveLength(1);
    const sample = rows[0];
    // Our seeded succeeded row guarantees at least one (the live 5-minute
    // cadence's rows for the same jobid may add more — never pinned here).
    expect(Number(sample.succeeded)).toBeGreaterThanOrEqual(1);
    expect(Number(sample.failed)).toBeGreaterThanOrEqual(0);
    // age_seconds = now() - max(end_time) over the 24 h window — a
    // non-negative, bounded number, whatever the live cadence last wrote.
    expect(Number.isFinite(Number(sample.age_seconds))).toBe(true);
    expect(Number(sample.age_seconds)).toBeGreaterThanOrEqual(0);
    expect(Number(sample.age_seconds)).toBeLessThan(24 * 3600);

    binder.onModuleDestroy();
    expect(getReminderJobMetricQuery()).toBeNull();
  });
});
