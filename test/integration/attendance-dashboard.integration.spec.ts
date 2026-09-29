/**
 * 19-2 / 19-3 real-DB read-API probes (spec D5/D6) — the owner dashboard
 * (five tiles + the two unresolved-past-flag strips via DashboardService +
 * DashboardFlagReads) and the monthly & self-view reads (MonthlyService).
 *
 * Assertions are ENGINE-authoritative: the tiles derive from the SAME
 * `readDayStatusGrid` + `computeDayStatus` the calendar shows, so a tile
 * test pins counts over seeded facts, and FR-11's owner↔me parity is
 * structural (both routes over the same rows are deep-equal). The flag
 * strips run dashboard-flags.ts's targeted SQL, whose rule-8 mirror is
 * cross-checked against the engine's `checkout_missing` markers over the
 * same facts (the §6 parity probe at the real-DB boundary, not an
 * assumption).
 *
 * Requires real credentials like the other probes (gated on DATABASE_URL /
 * SUPABASE_* being set and NOT the jest.env.setup.ts dummies). Fixtures
 * are self-contained (throwaway tenant) and removed in afterAll in
 * FK-safe order (records/attempts/rules RESTRICT to their parents).
 */
import { Pool } from 'pg';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { PgPoolFactory } from '../../src/common/pg/pg-pool.factory';
import { SupabaseClientFactory } from '../../src/common/factories/supabase-client.factory';
import { DashboardService } from '../../src/attendance/dashboard';
import { DashboardFlagReads } from '../../src/attendance/dashboard-flags';
import { MonthlyService } from '../../src/attendance/monthly';
import { readDayStatusGrid } from '../../src/attendance/day-status.read';
import { computeDayStatus } from '../../src/attendance/day-status.model';
import type { RequestUser } from '../../src/common/interfaces/request-user.interface';

const DATABASE_URL = process.env['DATABASE_URL'] ?? '';
const SUPABASE_URL = process.env['SUPABASE_URL'] ?? '';
const SUPABASE_SERVICE_ROLE_KEY =
  process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';
const IS_REAL_DB =
  DATABASE_URL !== '' &&
  !DATABASE_URL.includes('test:test') &&
  SUPABASE_URL !== '' &&
  !SUPABASE_URL.includes('test.supabase.co');

jest.setTimeout(120_000);

const TZ = 'Asia/Kolkata';
const OFF = '+05:30';

const TENANT = randomUUID();
const OWNER = randomUUID();
/** The crew (names carry the seed order — the roster sorts by name):
 *  tech 1 (A) = in-progress today; tech 2 (B) = the flag-strip fixture;
 *  tech 3 (C) = approved full-day leave today; tech 4 (gate) = NO
 *  enrolment (the me-route 403 gate); tech 5 (E) = enrolled but assigned
 *  to an ARCHIVED office (excluded from the tracked set); tech 6 (F) =
 *  a LATE check-in today; tech 7 (G) = never shows; tech 8 (future) =
 *  starts TOMORROW (FR-2 exclusion); tech 9 (history) = history-only. */
const TECHS = {
  A: randomUUID(),
  B: randomUUID(),
  C: randomUUID(),
  gate: randomUUID(),
  E: randomUUID(),
  F: randomUUID(),
  G: randomUUID(),
  future: randomUUID(),
  history: randomUUID(),
} as const;

const PHONES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(
  (i) => `7${Date.now()}`.slice(-10).replace(/^./, '7') + String(i),
);

const techName = (i: number): string => `probe tech ${i}`;

/** A tenant-local instant spelled for pg: `${d} ${time}${OFF}`. */
const ist = (d: string, time: string): string => `${d} ${time}${OFF}`;

describe('Attendance dashboard + monthly reads (19-2/19-3, real DB)', () => {
  const maybeIt = IS_REAL_DB ? it : it.skip;
  let pool: Pool;
  let admin: SupabaseClient;
  let pg: PgPoolFactory;
  let dashboard: DashboardService;
  let monthly: MonthlyService;
  let today: string;
  let officeId: string;
  let ruleId: string;
  let d1: string; // yesterday
  let d2: string; // two days ago
  let d3: string; // three days ago
  let ARCHIVE_ID: string; // the archived office tech 5 sits at

  const user = (
    userId: string,
    role: 'owner' | 'technician',
  ): RequestUser =>
    ({ userId, tenantId: TENANT, role, rawJwt: 'probe-jwt' }) as unknown as RequestUser;

  const must = <T>(
    res: { data: T | null; error: { message: string } | null },
  ): T => {
    if (res.error) throw new Error(`fixture failed: ${res.error.message}`);
    return res.data as T;
  };

  /** Catch the exception and assert its status + error_code — the call is
   * invoked INSIDE (forOwner may throw synchronously, before any promise). */
  async function expectHttpException(
    call: () => unknown,
    status: number,
    errorCode: string,
  ): Promise<void> {
    try {
      await call();
      throw new Error(`expected ${errorCode} (${status})`);
    } catch (err) {
      const e = err as { status?: number; getResponse?: () => unknown };
      expect(e.status).toBe(status);
      expect((e.getResponse?.() as Record<string, unknown>)['error_code']).toBe(
        errorCode,
      );
    }
  }

  /** Engine marker set over [from, to] — rule 8's mirror for flag parity. */
  async function engineCheckoutMissing(
    employeeIds: string[],
    from: string,
    to: string,
  ): Promise<Set<string>> {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const rows = await readDayStatusGrid(
        client,
        TENANT,
        employeeIds,
        from,
        to,
      );
      const flagged = new Set<string>();
      for (const row of rows) {
        if (!row.ctx.tracked) continue;
        const outcome = computeDayStatus({
          ctx: row.ctx,
          record: row.record,
          override: row.override,
          hasUnackMockedAttempt: row.hasUnackMockedAttempt,
          today: row.today,
        });
        if (
          row.workDate < today &&
          outcome.markers.includes('checkout_missing')
        ) {
          flagged.add(`${row.employeeId}|${row.workDate}`);
        }
      }
      await client.query('commit');
      return flagged;
    } finally {
      client.release();
    }
  }

  /** Past-day record: check-in always, check-out optional. */
  const seedRecord = async (
    employeeId: string,
    date: string,
    checkinTime: string,
    checkoutTime: string | null,
  ): Promise<void> => {
    const attemptIn = (
      await pool.query<{ id: string }>(
        `insert into public.attendance_attempts
           (tenant_id, employee_id, request_id, kind, outcome, attempted_at, mocked)
         values ($1, $2, gen_random_uuid(), 'check_in', 'ok', $3, false) returning id`,
        [TENANT, employeeId, ist(date, checkinTime)],
      )
    ).rows[0].id;
    if (checkoutTime === null) {
      await pool.query(
        `insert into public.attendance_records
           (tenant_id, employee_id, work_date, office_id, office_rules_id, radius_m,
            checkin_at, checkin_attempt_id, checkin_lat, checkin_lng,
            checkin_accuracy_m, checkin_distance_m, checkin_mocked)
         values ($1, $2, $3, $4, $5, 100, $6, $7, 12.97, 77.59, 10, 40, false)`,
        [TENANT, employeeId, date, officeId, ruleId, ist(date, checkinTime), attemptIn],
      );
      return;
    }
    const attemptOut = (
      await pool.query<{ id: string }>(
        `insert into public.attendance_attempts
           (tenant_id, employee_id, request_id, kind, outcome, attempted_at, mocked)
         values ($1, $2, gen_random_uuid(), 'check_out', 'ok', $3, false) returning id`,
        [TENANT, employeeId, ist(date, checkoutTime)],
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
        TENANT, employeeId, date, officeId, ruleId,
        ist(date, checkinTime), attemptIn, ist(date, checkoutTime), attemptOut,
      ],
    );
  };

  /** An unacknowledged mocked attempt (the AD-10 fake-location fact). */
  const seedMockedAttempt = async (
    employeeId: string,
    date: string,
    time: string,
  ): Promise<void> => {
    await pool.query(
      `insert into public.attendance_attempts
         (tenant_id, employee_id, request_id, kind, outcome, latitude, longitude,
          accuracy_m, distance_m, radius_m, mocked, attempted_at)
       values ($1, $2, gen_random_uuid(), 'check_in', 'mocked',
               19.0, 73.0, 900, 5000, 100, true, $3)`,
      [TENANT, employeeId, ist(date, time)],
    );
  };

  beforeAll(async () => {
    if (!IS_REAL_DB) return;
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 2,
    });

    // Self-heal first: when a previous run's beforeAll crashes, jest never
    // reaches afterAll, and the users seeded (tenant-less by design until
    // the tenant row exists) leak as orphans. The signature is this probe's
    // alone — tenant-less + probe names, older than 10 minutes (a still-
    // running crashed process is never raced).
    await pool.query(
      `delete from public.users
       where tenant_id is null
         and (name = 'probe owner' or name like 'probe tech %')
         and created_at < now() - interval '10 minutes'`,
    );
    admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    pg = new PgPoolFactory({
      getOrThrow: (k: string) => {
        const v = process.env[k];
        if (!v) throw new Error(`missing config key ${k}`);
        return v;
      },
    } as unknown as ConfigService);
    dashboard = new DashboardService(pg, new DashboardFlagReads());
    monthly = new MonthlyService(pg, {
      createAdmin: () => admin,
    } as unknown as SupabaseClientFactory);

    // ---- owner → tenant → technicians → settings → office + rule ----
    must(
      await admin.from('users').insert({
        id: OWNER,
        role: 'owner',
        status: 'active',
        country_code: '+91',
        phone_number: PHONES[0],
        name: 'probe owner',
      }),
    );
    must(
      await admin.from('users').insert(
        Object.values(TECHS).map((id, i) => ({
          id,
          role: 'technician',
          status: 'active',
          country_code: '+91',
          phone_number: PHONES[i + 1],
          name: techName(i + 1),
        })),
      ),
    );
    must(
      await admin.from('tenants').insert({
        id: TENANT,
        owner_id: OWNER,
        company_name: `19-2/19-3 dashboard probe ${TENANT.slice(0, 8)}`,
        state_code: 'KA',
        timezone: TZ,
      }),
    );
    must(
      await admin
        .from('users')
        .update({ tenant_id: TENANT })
        .in('id', [...Object.values(TECHS), OWNER]),
    );
    must(
      await admin.from('attendance_settings').insert({
        tenant_id: TENANT,
        enabled: true,
        setup_completed_at: new Date().toISOString(),
      }),
    );
    officeId = must(
      await admin
        .from('attendance_offices')
        .insert({
          tenant_id: TENANT,
          name: 'dashboard probe office',
          latitude: 12.97,
          longitude: 77.59,
          radius_m: 100,
        })
        .select('id')
        .single(),
    ).id;
    ruleId = must(
      await admin
        .from('attendance_office_rules')
        .insert({
          tenant_id: TENANT,
          office_id: officeId,
          valid: '[2000-01-01,)', // covers past AND far-future probe dates
          start_time: '09:30',
          end_time: '18:30',
          late_cutoff_minutes: 15,
          full_day_hours: 8,
          half_day_hours: 4,
        })
        .select('id')
        .single(),
    ).id;

    today = (
      await pool.query<{ today: string }>(
        'select (now() at time zone $1)::date::text as today',
        [TZ],
      )
    ).rows[0].today;
    /** Tenant-local `YYYY-MM-DD` text, N days from today. */
    const dayOffset = async (n: number): Promise<string> =>
      (
        await pool.query<{ d: string }>(
          'select ((now() at time zone $1)::date + $2::int)::text as d',
          [TZ, n],
        )
      ).rows[0].d;
    d1 = await dayOffset(-1);
    d2 = await dayOffset(-2);
    d3 = await dayOffset(-3);

    // ---- enrolments + covering assignments — the coverage guard is
    // DEFERRABLE (fires at COMMIT), so every enrolment+assignment pair
    // commits inside ONE transaction; tech 5/E's only covering office is
    // still LIVE at that commit, archived under it right after ----
    ARCHIVE_ID = must(
      await admin
        .from('attendance_offices')
        .insert({
          tenant_id: TENANT,
          name: 'archived probe office',
          latitude: 12.98,
          longitude: 77.6,
          radius_m: 100,
        })
        .select('id')
        .single(),
    ).id;
    const legs = await pool.connect();
    try {
      await legs.query('begin');
      for (const t of [TECHS.A, TECHS.B, TECHS.C, TECHS.F, TECHS.G]) {
        await legs.query(
          `insert into public.attendance_enrolments (tenant_id, employee_id, valid, enabled_at)
           values ($1, $2, daterange(current_date - 60, null, '[)'), now() - interval '60 days')`,
          [TENANT, t],
        );
        await legs.query(
          `insert into public.attendance_office_assignments
             (tenant_id, employee_id, office_id, valid)
           values ($1, $2, $3, daterange(current_date - 60, null, '[)'))`,
          [TENANT, t, officeId],
        );
      }
      // E (tech 5): an OPEN enrolment whose covering office is still live
      // at this commit.
      await legs.query(
        `insert into public.attendance_enrolments (tenant_id, employee_id, valid, enabled_at)
         values ($1, $2, daterange(current_date - 60, null, '[)'), now() - interval '60 days')`,
        [TENANT, TECHS.E],
      );
      await legs.query(
        `insert into public.attendance_office_assignments
           (tenant_id, employee_id, office_id, valid)
         values ($1, $2, $3, daterange(current_date - 60, null, '[)'))`,
        [TENANT, TECHS.E, ARCHIVE_ID],
      );
      // Future (tech 8): starts TOMORROW — excluded from today's tracked set.
      const tomorrow = await dayOffset(1);
      await legs.query(
        `insert into public.attendance_enrolments (tenant_id, employee_id, valid, enabled_at)
         values ($1, $2, daterange($3::date, null, '[)'), now())`,
        [TENANT, TECHS.future, tomorrow],
      );
      await legs.query(
        `insert into public.attendance_office_assignments
           (tenant_id, employee_id, office_id, valid)
         values ($1, $2, $3, daterange($4::date, null, '[)'))`,
        [TENANT, TECHS.future, officeId, tomorrow],
      );
      // History-only (tech 9, FR-28): period clipped so it covers D-3..D-1
      // only, with one complete record inside it.
      await legs.query(
        `insert into public.attendance_enrolments (tenant_id, employee_id, valid, enabled_at)
         values ($1, $2, daterange(current_date - 3, current_date, '[)'), now() - interval '60 days')`,
        [TENANT, TECHS.history],
      );
      await legs.query(
        `insert into public.attendance_office_assignments
           (tenant_id, employee_id, office_id, valid)
         values ($1, $2, $3, daterange(current_date - 3, current_date, '[)'))`,
        [TENANT, TECHS.history, officeId],
      );
      await legs.query('commit');
    } finally {
      legs.release();
    }
    await seedRecord(TECHS.history, d2, '09:40:00', '18:31:00');

    // Archive the second office UNDER tech 5's open enrolment — archiving
    // offices fires no coverage guard (the owner reassigns later, in the
    // lifecycle); from here `o.archived_at is null` excludes T5 from the
    // tile set and both flag strips.
    await pool.query(
      `update public.attendance_offices set archived_at = now() where id = $1`,
      [ARCHIVE_ID],
    );

    // ---- today's rows for the tiles ----
    await seedRecord(TECHS.A, d1, '09:40:00', '18:31:00');
    await seedRecord(TECHS.A, today, '09:40:00', null); // in_progress
    // F: a LATE check-in today (well past Start + Late cut-off).
    await seedRecord(TECHS.F, today, '12:00:00', null);

    // ---- B: the flag-strip fixture over the PAST days ----
    // D-3: check-in with NO check-out but a status adjudication → NEVER
    // flagged (rule 1's short-circuit; a status correction clears the flag).
    await seedRecord(TECHS.B, d3, '09:40:00', null);
    await pool.query(
      `insert into public.attendance_day_overrides
         (tenant_id, employee_id, work_date, status, created_by)
       values ($1, $2, $3, 'absent', $4)`,
      [TENANT, TECHS.B, d3, OWNER],
    );
    // D-2: a check-in with NO check-out, unadjudicated → strip row 1.
    await seedRecord(TECHS.B, d2, '09:40:00', null);
    // D-1: an override-ONLY day (manual check-in, no record row) → row 2.
    await pool.query(
      `insert into public.attendance_day_overrides
         (tenant_id, employee_id, work_date, manual_checkin_at, created_by)
       values ($1, $2, $3, $4, $5)`,
      [TENANT, TECHS.B, d1, ist(d1, '10:00:00'), OWNER],
    );

    // Approved FULL-day leave TODAY for C (the on-leave tile).
    const lr = (
      await pool.query<{ id: string }>(
        `insert into public.leave_requests
           (tenant_id, employee_id, request_id, start_date, end_date, part, reason, created_by)
         values ($1, $2, gen_random_uuid(), $3, $3, 'full_day', 'probe leave', $4) returning id`,
        [TENANT, TECHS.C, today, OWNER],
      )
    ).rows[0].id;
    await pool.query(
      `insert into public.leave_request_days
         (tenant_id, leave_request_id, employee_id, leave_date, state)
       values ($1, $2, $3, $4, 'approved')`,
      [TENANT, lr, TECHS.C, today],
    );

    // Unacknowledged mocked attempts — grouped per employee-date; they all
    // land on D-1 so TODAY's rows stay clean for the tiles.
    await seedMockedAttempt(TECHS.A, d1, '11:00:00');
    await seedMockedAttempt(TECHS.A, d1, '11:30:00');
    await seedMockedAttempt(TECHS.B, d1, '12:00:00');
  });

  afterAll(async () => {
    if (!IS_REAL_DB) return;
    // FK-safe order: records/attempts first (attempts RESTRICT via the
    // record's attempt refs), rules BEFORE offices (rules RESTRICT to
    // offices); the tenant drop takes whatever a leg missed.
    await admin.from('notifications').delete().eq('tenant_id', TENANT);
    await pool.query(
      `delete from public.leave_request_days where tenant_id = $1`,
      [TENANT],
    );
    await pool.query(
      `delete from public.leave_requests where tenant_id = $1`,
      [TENANT],
    );
    await pool.query(
      `delete from public.attendance_records where tenant_id = $1`,
      [TENANT],
    );
    await pool.query(
      `delete from public.attendance_attempts where tenant_id = $1`,
      [TENANT],
    );
    await pool.query(
      `delete from public.attendance_day_overrides where tenant_id = $1`,
      [TENANT],
    );
    await admin
      .from('attendance_enrolments')
      .delete()
      .eq('tenant_id', TENANT);
    await admin
      .from('attendance_office_assignments')
      .delete()
      .eq('tenant_id', TENANT);
    await admin
      .from('attendance_office_rules')
      .delete()
      .eq('tenant_id', TENANT);
    await admin.from('attendance_offices').delete().eq('tenant_id', TENANT);
    await admin
      .from('attendance_setup_progress')
      .delete()
      .eq('tenant_id', TENANT);
    await admin.from('attendance_onboarding').delete().eq('tenant_id', TENANT);
    await admin
      .from('attendance_weekly_off_defaults')
      .delete()
      .eq('tenant_id', TENANT);
    await admin.from('attendance_settings').delete().eq('tenant_id', TENANT);
    // Tenants first (the drop orphans users via the owner FK's SET NULL),
    // THEN the probe's users legs — the reverse order would violate
    // tenants_owner_id_fkey on the owner and silently skip the whole leg.
    await admin.from('tenants').delete().eq('id', TENANT);
    const del = await admin
      .from('users')
      .delete()
      .in('id', [...Object.values(TECHS), OWNER]);
    if (del.error) throw new Error(`users leak: ${del.error.message}`);
    await pool.end();
  });

  maybeIt('the five tiles answer the engine grid exactly (overlaps included)', async () => {
    const res = await dashboard.today(user(OWNER, 'owner'));
    expect(res.date).toBe(today);
    // Tracked = enrolment ∩ assignment ∩ ACTIVE office covering today:
    // techs 1, 2, 3, 6, 7 (E's office is archived; future is not live yet;
    // history's period ended yesterday; gate has no enrolment at all).
    expect(res.counts.tracked).toBe(5);
    // checkedIn: A's in_progress leg + F's present leg. The five tiles are
    // SEPARATE questions, never a partition of tracked.
    expect(res.counts.checkedIn).toBe(2);
    expect(res.counts.notCheckedIn).toBe(2); // B, G
    expect(res.counts.late).toBe(1); // F's 12:00 check-in
    expect(res.counts.onLeave).toBe(1); // C's approved full-day leave
    // The strips are PAST-window reads by design (they surface unresolved
    // history on today's dashboard) — B's past days flag here and the
    // attempts on D-1 bucket by the ATTEMPT date; their exact contents
    // are pinned by the flag-strip probe below.
    for (const flag of res.flags.checkoutMissing) {
      expect(flag.employeeId).toBe(TECHS.B);
      expect(flag.workDate < today).toBe(true);
    }
    for (const flag of res.flags.fakeLocationAttempt) {
      expect([TECHS.A, TECHS.B]).toContain(flag.employeeId);
      expect(flag.workDate).toBe(d1);
    }
  });

  maybeIt('the flag strips mirror the engine exactly, including override-only days', async () => {
    const res = await dashboard.today(user(OWNER, 'owner'));

    // Checkout-missing: the D-2 record leg + the D-1 override-ONLY leg;
    // B's adjudicated D-3 record is NEVER flagged (rule 1). Order: the
    // strip sorts by work_date asc, then resolved name asc.
    expect(res.flags.checkoutMissing).toEqual([
      {
        employeeId: TECHS.B,
        employeeName: 'probe tech 2',
        workDate: d2,
        officeName: 'dashboard probe office',
      },
      {
        employeeId: TECHS.B,
        employeeName: 'probe tech 2',
        workDate: d1,
        officeName: 'dashboard probe office',
      },
    ]);
    // Fake-location: unacknowledged attempts grouped per employee-date,
    // the office of the assignment covering the ATTEMPT date.
    expect(res.flags.fakeLocationAttempt).toEqual([
      {
        employeeId: TECHS.A,
        employeeName: 'probe tech 1',
        workDate: d1,
        officeName: 'dashboard probe office',
        attemptCount: 2,
      },
      {
        employeeId: TECHS.B,
        employeeName: 'probe tech 2',
        workDate: d1,
        officeName: 'dashboard probe office',
        attemptCount: 1,
      },
    ]);

    // PARITY — the wire set equals the engine's rule-8 marker set over the
    // same facts (the §6 boundary check, not an assumption).
    const engine = await engineCheckoutMissing(
      [TECHS.A, TECHS.B, TECHS.C, TECHS.F, TECHS.G],
      d2,
      d1,
    );
    const wireSet = new Set(
      res.flags.checkoutMissing.map((f) => `${f.employeeId}|${f.workDate}`),
    );
    expect([...wireSet].sort()).toEqual([...engine].sort());
  });

  maybeIt('an unknown-but-well-formed officeId answers 200 with zeros, never 404', async () => {
    const res = await dashboard.today(user(OWNER, 'owner'), randomUUID());
    expect(res.counts).toEqual({
      tracked: 0,
      checkedIn: 0,
      notCheckedIn: 0,
      late: 0,
      onLeave: 0,
    });
    expect(res.flags).toEqual({ checkoutMissing: [], fakeLocationAttempt: [] });
  });

  maybeIt('monthly range rules: 31 days reads, 32 and future-end 422', async () => {
    const d31 = await scalarDate(-30);
    const d32 = await scalarDate(-31);
    const dNext = await scalarDate(1);

    // Exactly a month → reads (200), ending at tenant-today.
    const ok = await monthly.forOwner(user(OWNER, 'owner'), d31, today);
    expect(ok.from).toBe(d31);
    expect(ok.to).toBe(today);

    // A 32-day span, BOTH routes, validated before any SQL.
    for (const read of [
      () => monthly.forOwner(user(OWNER, 'owner'), d32, today),
      () => monthly.forMe(user(TECHS.A, 'technician'), d32, today),
    ]) {
      await expectHttpException(read, 422, 'ATTENDANCE_INVALID_RANGE');
    }
    // A future END inside the span — the clock check inside the
    // transaction: the aggregate is earned credits only.
    await expectHttpException(
      () => monthly.forOwner(user(OWNER, 'owner'), today, dNext),
      422,
      'ATTENDANCE_INVALID_RANGE',
    );
    // from > to, and malformed input.
    await expectHttpException(
      () => monthly.forMe(user(TECHS.A, 'technician'), today, d31),
      422,
      'ATTENDANCE_INVALID_RANGE',
    );
    await expectHttpException(
      () => monthly.forOwner(user(OWNER, 'owner'), '2026-9-1', today),
      422,
      'ATTENDANCE_INVALID_RANGE',
    );
  });

  maybeIt('the owner monthly read answers the roster shape with engine-true summaries', async () => {
    const res = await monthly.forOwner(user(OWNER, 'owner'), d3, today);

    // The crew's enrolled rows: techs 1, 2, 3, 5, 6, 7, 9 — gate has no
    // enrolment, future's enrolment starts tomorrow (excluded).
    expect(res.employees.map((e) => e.employeeName)).toEqual([
      'probe tech 1',
      'probe tech 2',
      'probe tech 3',
      'probe tech 5',
      'probe tech 6',
      'probe tech 7',
      'probe tech 9',
    ]);

    // FR-28: the history-only employee stays listed; their TODAY office
    // is NULL (their assignment window ended with the clip).
    const history = res.employees.find((e) => e.employeeId === TECHS.history)!;
    expect(history.officeId).toBeNull();
    expect(history.officeName).toBeNull();
    // Their only tracked leg: the D-2 complete record; D-3/D-1 absents.
    expect(history.summary).toEqual({
      daysWorked: 1,
      halfDays: 0,
      lateCount: 0,
      leave: 0,
      weeklyOffs: 0,
      holidays: 0,
      workedOnHoliday: 0,
      absent: 2,
      checkoutMissing: 0,
    });

    // The idle technician's rule-9 facts: three past absences.
    const g = res.employees.find((e) => e.employeeId === TECHS.G)!;
    expect(g.summary).toEqual({
      daysWorked: 0,
      halfDays: 0,
      lateCount: 0,
      leave: 0,
      weeklyOffs: 0,
      holidays: 0,
      workedOnHoliday: 0,
      absent: 3,
      checkoutMissing: 0,
    });

    // B's flag facts mirror the strip: two unadjudicated past days with a
    // check-in and no check-out.
    const b = res.employees.find((e) => e.employeeId === TECHS.B)!;
    expect(b.summary.checkoutMissing).toBe(2);

    // C's approved full-day leave credits exactly 1 in the range.
    const c = res.employees.find((e) => e.employeeId === TECHS.C)!;
    expect(c.summary.leave).toBe(1);

    // F's late check-in counts once.
    const f = res.employees.find((e) => e.employeeId === TECHS.F)!;
    expect(f.summary.lateCount).toBe(1);

    // E's roster office is the archived one (the CURRENT assignment).
    const e2 = res.employees.find((e) => e.employeeId === TECHS.E)!;
    expect(e2.officeName).toBe('archived probe office');
  });

  maybeIt('an officeId filter narrows the set; an unknown one answers empty, never 404', async () => {
    const live = await monthly.forOwner(
      user(OWNER, 'owner'),
      d3,
      today,
      officeId,
    );
    // Only employees whose TODAY-covering office is the filter: the live
    // roster five (E sits at the archived office; history has no TODAY
    // covering assignment at all).
    expect(live.employees.map((e) => e.employeeId).sort()).toEqual(
      [TECHS.A, TECHS.B, TECHS.C, TECHS.F, TECHS.G].sort(),
    );

    const unknown = await monthly.forOwner(
      user(OWNER, 'owner'),
      d3,
      today,
      randomUUID(), // well-formed, no such office — a filter, not a fetch
    );
    expect(unknown).toEqual({ from: d3, to: today, employees: [] });
  });

  maybeIt('FR-11 parity — the owner row and the self view agree cell for cell', async () => {
    const ownerRes = await monthly.forOwner(user(OWNER, 'owner'), d3, today);
    const meRes = await monthly.forMe(user(TECHS.A, 'technician'), d3, today);

    const ownerRow = ownerRes.employees.find((e) => e.employeeId === TECHS.A)!;
    // One aggregation function over the same grid rows → the summaries are
    // DEEP-equal for the same employee (the structural parity contract).
    expect(ownerRow.summary).toEqual(meRes.summary);
    // The self view's cards: no weekly-off default seeded → none effective;
    // no holidays seeded → the upcoming list is empty.
    expect(meRes.weeklyOffs).toEqual([]);
    expect(meRes.upcomingHolidays).toEqual([]);
    expect(meRes.from).toBe(d3);
    expect(meRes.to).toBe(today);
  });

  maybeIt('the me-route access gate: an unenrolled technician reads 403, never entity data', async () => {
    // TECHS.gate has a user row but NO enrolment — the AD-17 view reads
    // access_state none → 403 ATTENDANCE_NOT_TRACKED (deny-by-default).
    await expectHttpException(
      () => monthly.forMe(user(TECHS.gate, 'technician'), today, today),
      403,
      'ATTENDANCE_NOT_TRACKED',
    );
  });

  maybeIt('FR-28 — the history-only technician’s self view equals their owner row', async () => {
    // history's enrolment is clipped out of TODAY → the AD-17 view reads
    // history_only, which stays READABLE per D6 (the 18-x me-route
    // precedent): the self view over the clipped period answers the same
    // summary the owner's roster row shows.
    const ownerRes = await monthly.forOwner(user(OWNER, 'owner'), d3, today);
    const meRes = await monthly.forMe(
      user(TECHS.history, 'technician'),
      d3,
      today,
    );
    const ownerRow = ownerRes.employees.find(
      (e) => e.employeeId === TECHS.history,
    )!;
    expect(meRes.summary).toEqual(ownerRow.summary);
  });

  maybeIt('the self cards read SEEDED data — an override REPLACES the tenant default; holidays from tomorrow list', async () => {
    // RUNS LAST-ISH + self-cleaning: a tenant default (Monday+Sunday) and
    // A's override (Monday) REPLACING it today — the pickWeeklyOffDays
    // contract on D6's weeklyOffs — plus a holiday from tomorrow for the
    // card's `holiday_date >= today` read. The finally removes all three
    // so the empty-card pins above keep holding on every future run.
    const tomorrow = await scalarDate(1);
    must(
      await admin.from('attendance_weekly_off_defaults').insert({
        tenant_id: TENANT,
        valid: '[2000-01-01,)',
        days: [1, 7],
      }),
    );
    must(
      await admin.from('attendance_weekly_off_overrides').insert({
        tenant_id: TENANT,
        employee_id: TECHS.A,
        valid: '[2000-01-01,)',
        days: [7],
      }),
    );
    must(
      await admin
        .from('holidays')
        .insert({ tenant_id: TENANT, holiday_date: tomorrow, name: 'probe fest' }),
    );
    try {
      const meRes = await monthly.forMe(
        user(TECHS.A, 'technician'),
        d3,
        today,
      );
      // The override's days win — the earlier `weeklyOffs: []` probe above
      // stays green only because this seed lands after it and cleans up.
      expect(meRes.weeklyOffs).toEqual([7]);
      expect(meRes.upcomingHolidays).toEqual([
        { holidayDate: tomorrow, holidayName: 'probe fest' },
      ]);
    } finally {
      await admin
        .from('attendance_weekly_off_overrides')
        .delete()
        .eq('tenant_id', TENANT)
        .eq('employee_id', TECHS.A);
      await admin
        .from('attendance_weekly_off_defaults')
        .delete()
        .eq('tenant_id', TENANT)
        .eq('valid', '[2000-01-01,)');
      await admin
        .from('holidays')
        .delete()
        .eq('tenant_id', TENANT)
        .eq('holiday_date', tomorrow);
    }
  });

  /** Tenant-local `YYYY-MM-DD` text helper shared by the range probes. */
  async function scalarDate(n: number): Promise<string> {
    return (
      await pool.query<{ d: string }>(
        'select ((now() at time zone $1)::date + $2::int)::text as d',
        [TZ, n],
      )
    ).rows[0].d;
  }
});
