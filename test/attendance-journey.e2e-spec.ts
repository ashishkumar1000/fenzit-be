import { INestApplication, ValidationPipe } from '@nestjs/common';
import { VALIDATION_PIPE_OPTIONS } from '../src/common/validation-pipe-options';
import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { JwtService } from '@nestjs/jwt';
import { AppModule } from '../src/app.module';
import { Pool } from 'pg';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';

/**
 * The attendance module's real-DB JOURNEY suite (the standing rule: every
 * attendance backend story appends its user steps here in epic order; each
 * step = ONE real API call + the DB as referee). Unlike the service probes
 * in test/integration/, this suite drives ROUTES — nothing is overridden:
 * the real DB, the guards and the ValidationPipe all run.
 *
 * NOTE (19-4): this run STARTED the suite with the 19-4 dashboard leg.
 * The 14-2 → 18-x backend legs predate the suite and are a separate
 * BACKFILL story — this file holds only the legs that have actually run,
 * appends going forward.
 *
 * Requires real credentials (DATABASE_URL / SUPABASE_URL + service key, NOT
 * the jest.env.setup.ts dummies) — skipped otherwise. Throwaway tenant per
 * run, removed in cleanup() in FK-safe order (records/attempts RESTRICT to
 * their parents, rules RESTRICT to offices).
 */

const DATABASE_URL = process.env['DATABASE_URL'] ?? '';
const SUPABASE_URL = process.env['SUPABASE_URL'] ?? '';
const SUPABASE_SERVICE_KEY =
  process.env['SUPABASE_SERVICE_ROLE_KEY'] ??
  process.env['SUPABASE_SERVICE_KEY'] ??
  '';
const IS_REAL_DB =
  DATABASE_URL.includes('@') &&
  SUPABASE_URL.startsWith('https://') &&
  !SUPABASE_URL.startsWith('https://test.supabase.co') &&
  SUPABASE_SERVICE_KEY !== '';

jest.setTimeout(120_000);

const TZ = 'Asia/Kolkata';
const OFF = '+05:30';

/** Unwrap a MUST-succeed supabase call. */
function must<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(`fixture failed: ${res.error.message}`);
  return res.data as T;
}

describe('Attendance journey (real DB, real routes)', () => {
  const maybeIt = IS_REAL_DB ? it : it.skip;
  let app: NestFastifyApplication;
  let jwt: JwtService;
  let pool: Pool;
  let admin: SupabaseClient;

  const owner = randomUUID();
  const techs = [randomUUID(), randomUUID()];
  const tenant = randomUUID();
  const phones = Array.from({ length: 3 }, (_, i) =>
    `7${Date.now()}${i}`.slice(-12).replace(/[^0-9]/g, ''),
  );

  /** The leg's bearer — sub/tenantId/role read by the guards. */
  const bearerFor = (userId: string, role: 'owner' | 'technician'): string =>
    jwt.sign({ sub: userId, tenantId: tenant, role });

  beforeAll(async () => {
    if (!IS_REAL_DB) return;
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 2,
    });
    admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    jwt = moduleFixture.get(JwtService);

    // The users before the tenant (the tenant FK's owner leg), the tenant,
    // then the crew's tenant links — the other probes' order.
    must(
      await admin.from('users').insert({
        id: owner,
        role: 'owner',
        status: 'active',
        country_code: '+91',
        phone_number: phones[0],
        name: 'journey owner',
      }),
    );
    must(
      await admin.from('users').insert(
        techs.map((id, i) => ({
          id,
          role: 'technician',
          status: 'active',
          country_code: '+91',
          phone_number: phones[i + 1],
          name: `journey tech ${i + 1}`,
        })),
      ),
    );
    must(
      await admin.from('tenants').insert({
        id: tenant,
        owner_id: owner,
        company_name: `journey probe ${tenant.slice(0, 8)}`,
        state_code: 'KA',
        timezone: TZ,
      }),
    );
    must(
      await admin
        .from('users')
        .update({ tenant_id: tenant })
        .in('id', [owner, ...techs]),
    );
    must(
      await admin.from('attendance_settings').insert({
        tenant_id: tenant,
        enabled: true,
        setup_completed_at: new Date().toISOString(),
      }),
    );
  });

  afterAll(async () => {
    if (!IS_REAL_DB) return;
    await app.close();
    await cleanup(admin, pool, tenant, [owner, ...techs]);
    await pool.end();
  });

  maybeIt('19-4 — the owner reads the dashboard; an office filter narrows tiles AND flags, the registry never', async () => {
    const today = await scalarDate(0);
    const d1 = await scalarDate(-1);

    // Two live offices — the filtered steps below can only prove the
    // registry's full scope if narrowing the tiles leaves BOTH rows.
    const north = must(
      await admin
        .from('attendance_offices')
        .insert({
          tenant_id: tenant,
          name: 'journey north',
          latitude: 12.97,
          longitude: 77.59,
          radius_m: 100,
        })
        .select('id')
        .single(),
    ).id;
    const south = must(
      await admin
        .from('attendance_offices')
        .insert({
          tenant_id: tenant,
          name: 'journey south',
          latitude: 12.98,
          longitude: 77.6,
          radius_m: 100,
        })
        .select('id')
        .single(),
    ).id;
    const ruleNorth = await seedRule(north);
    const ruleSouth = await seedRule(south);

    // Enrolment ∩ assignment per tech, one leg per office, inside ONE
    // transaction (the coverage guard is DEFERRABLE — fires at COMMIT).
    const legs = await pool.connect();
    try {
      await legs.query('begin');
      const pairs: [string, string][] = [
        [techs[0], north],
        [techs[1], south],
      ];
      for (const [tech, office] of pairs) {
        await legs.query(
          `insert into public.attendance_enrolments
             (tenant_id, employee_id, valid, enabled_at)
           values ($1, $2, daterange(current_date - 60, null, '[)'), now() - interval '60 days')`,
          [tenant, tech],
        );
        await legs.query(
          `insert into public.attendance_office_assignments
             (tenant_id, employee_id, office_id, valid)
           values ($1, $2, $3, daterange(current_date - 60, null, '[)'))`,
          [tenant, tech, office],
        );
      }
      await legs.query('commit');
    } finally {
      legs.release();
    }

    // TECH 1 is in_progress today; TECH 2 left a resolution-less past day.
    await seedInOut(techs[0], today, north, ruleNorth, '09:40', null);
    await seedInOut(techs[1], d1, south, ruleSouth, '09:40', null);

    // REFEREE — the DB facts every API answer below must agree with: each
    // live office carries exactly one covering assignment today. Order-
    // independent compare — the SQL sorts by office_id, and the offices'
    // server-generated UUIDs do not sort in insertion order (the pin was
    // a run-order flake).
    const covering = await pool.query<{ office_id: string; cnt: string }>(
      `select office_id, count(*)::text as cnt
       from public.attendance_office_assignments
       where tenant_id = $1 and valid @> $2::date
       group by office_id order by office_id`,
      [tenant, today],
    );
    expect(new Map(covering.rows.map((r) => [r.office_id, r.cnt]))).toEqual(
      new Map([
        [north, '1'],
        [south, '1'],
      ]),
    );

    // STEP 1 — owner dashboard, unfiltered: both techs tracked, tech 1's
    // in_progress leg checked in, BOTH offices their own truth.
    let res = await app.inject({
      method: 'GET',
      url: '/api/v1/attendance/dashboard',
      headers: { authorization: `Bearer ${bearerFor(owner, 'owner')}` },
    });
    expect(res.statusCode).toBe(200);
    const unfiltered = JSON.parse(res.body);
    expect(unfiltered.counts).toEqual({
      tracked: 2,
      checkedIn: 1,
      notCheckedIn: 1,
      late: 0,
      onLeave: 0,
      // 20-2: Short day rides the four-bucket partition — zero here (no
      // rule-7 punch pair in this leg's fixture).
      shortDay: 0,
    });
    expect(unfiltered.offices).toEqual([
      { id: north, name: 'journey north', tracked: 1, checkedIn: 1 },
      { id: south, name: 'journey south', tracked: 1, checkedIn: 0 },
    ]);
    expect(unfiltered.flags.checkoutMissing).toEqual([
      {
        employeeId: techs[1],
        employeeName: 'journey tech 2',
        workDate: d1,
        officeName: 'journey south',
      },
    ]);

    // STEP 2 — the SAME read through the SOUTH filter: tiles narrow to
    // south, the strip narrows with the tiles' office — and the registry
    // stays FULL (the picker never inherits the fetch's filter; the
    // pre-fix BE zeroed BOTH offices on every filtered fetch).
    res = await app.inject({
      method: 'GET',
      url: `/api/v1/attendance/dashboard?officeId=${south}`,
      headers: { authorization: `Bearer ${bearerFor(owner, 'owner')}` },
    });
    expect(res.statusCode).toBe(200);
    const filtered = JSON.parse(res.body);
    expect(filtered.counts).toEqual({
      tracked: 1,
      checkedIn: 0,
      notCheckedIn: 1,
      late: 0,
      onLeave: 0,
      shortDay: 0,
    });
    expect(filtered.offices).toEqual(unfiltered.offices);
    expect(filtered.flags.checkoutMissing).toEqual(
      unfiltered.flags.checkoutMissing,
    );

    // A NORTH filter drops tech 2's past row out of the strip entirely.
    res = await app.inject({
      method: 'GET',
      url: `/api/v1/attendance/dashboard?officeId=${north}`,
      headers: { authorization: `Bearer ${bearerFor(owner, 'owner')}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).flags.checkoutMissing).toEqual([]);
  });

  maybeIt('19-5 — the owner monthly view echoes the tenant today, and the office filter narrows the rows', async () => {
    const today = await scalarDate(0);
    const d1 = await scalarDate(-1);
    const headers = { authorization: `Bearer ${bearerFor(owner, 'owner')}` };

    // The two-day window [d1, today] rides the 19-4 leg's fixtures
    // (enrolments cover 60 days back; tech 2's d1 record has a check-in
    // and no checkout — his summary must carry it as checkout missing).
    let res = await app.inject({
      method: 'GET',
      url: `/api/v1/attendance/monthly?from=${d1}&to=${today}`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    const unfiltered = JSON.parse(res.body) as {
      today: string;
      employees: Array<{ employeeName: string; summary: { checkoutMissing: number } }>;
    };
    // The `today` echo (19-5 D2): the FE clamps its current-month window
    // against THIS value — the wire truth, never a client clock.
    expect(unfiltered.today).toBe(today);
    expect(unfiltered.employees).toHaveLength(2);
    const tech2 = unfiltered.employees.find(e => e.employeeName === 'journey tech 2');
    expect(tech2?.summary.checkoutMissing).toBe(1);

    // The filter intersects with the today-covering assignment office
    // (BE D6): filtering by tech 1's covering office leaves exactly his
    // row, echo intact. (The offices live in the 19-4 leg's scope — the
    // covering assignment is the referee read, not a shared constant.)
    const tech1Office = (
      await pool.query<{ office_id: string }>(
        `select office_id from public.attendance_office_assignments
         where tenant_id = $1 and employee_id = $2 and valid @> $3::date
         limit 1`,
        [tenant, techs[0], today],
      )
    ).rows[0].office_id;
    res = await app.inject({
      method: 'GET',
      url: `/api/v1/attendance/monthly?from=${d1}&to=${today}&officeId=${tech1Office}`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    const filtered = JSON.parse(res.body);
    expect(filtered.today).toBe(today);
    expect(filtered.employees.map((e: { employeeName: string }) => e.employeeName)).toEqual([
      'journey tech 1',
    ]);
  });

  /** An office rule covering every probe date. */
  async function seedRule(officeId: string): Promise<string> {
    return must(
      await admin
        .from('attendance_office_rules')
        .insert({
          tenant_id: tenant,
          office_id: officeId,
          valid: '[2000-01-01,)',
          start_time: '09:30',
          end_time: '18:30',
          late_cutoff_minutes: 15,
          full_day_hours: 8,
          half_day_hours: 4,
        })
        .select('id')
        .single(),
    ).id;
  }

  /** A record-with-attempt leg: check-in always, check-out optional. */
  async function seedInOut(
    employeeId: string,
    date: string,
    officeId: string,
    ruleId: string,
    checkinTime: string,
    checkoutTime: string | null,
  ): Promise<void> {
    const attemptIn = must(
      await admin
        .from('attendance_attempts')
        .insert({
          tenant_id: tenant,
          employee_id: employeeId,
          request_id: randomUUID(),
          kind: 'check_in',
          outcome: 'ok',
          attempted_at: `${date} ${checkinTime}${OFF}`,
          mocked: false,
        })
        .select('id')
        .single(),
    ).id;
    if (checkoutTime === null) {
      await pool.query(
        `insert into public.attendance_records
           (tenant_id, employee_id, work_date, office_id, office_rules_id, radius_m,
            checkin_at, checkin_attempt_id, checkin_lat, checkin_lng,
            checkin_accuracy_m, checkin_distance_m, checkin_mocked)
         values ($1, $2, $3, $4, $5, 100, $6, $7, 12.97, 77.59, 10, 40, false)`,
        [tenant, employeeId, date, officeId, ruleId, `${date} ${checkinTime}${OFF}`, attemptIn],
      );
      return;
    }
    const attemptOut = must(
      await admin
        .from('attendance_attempts')
        .insert({
          tenant_id: tenant,
          employee_id: employeeId,
          request_id: randomUUID(),
          kind: 'check_out',
          outcome: 'ok',
          attempted_at: `${date} ${checkoutTime}${OFF}`,
          mocked: false,
        })
        .select('id')
        .single(),
    ).id;
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
        tenant, employeeId, date, officeId, ruleId,
        `${date} ${checkinTime}${OFF}`, attemptIn,
        `${date} ${checkoutTime}${OFF}`, attemptOut,
      ],
    );
  }

  /** Tenant-local `YYYY-MM-DD` text, N days from today (N may be ≤ 0). */
  async function scalarDate(n: number): Promise<string> {
    return (
      await pool.query<{ d: string }>(
        'select ((now() at time zone $1)::date + $2::int)::text as d',
        [TZ, n],
      )
    ).rows[0].d;
  }
});

/** FK-safe teardown: the tenant last (orphaning nothing), users after. */
async function cleanup(
  admin: SupabaseClient,
  pool: Pool,
  tenantId: string,
  crew: string[],
): Promise<void> {
  void pool;
  await admin.from('notifications').delete().eq('tenant_id', tenantId);
  await admin.from('leave_request_days').delete().eq('tenant_id', tenantId);
  await admin.from('leave_requests').delete().eq('tenant_id', tenantId);
  await pool.query(`delete from public.attendance_records where tenant_id = $1`, [tenantId]);
  await pool.query(`delete from public.attendance_attempts where tenant_id = $1`, [tenantId]);
  await admin
    .from('attendance_day_overrides')
    .delete()
    .eq('tenant_id', tenantId);
  await admin.from('attendance_enrolments').delete().eq('tenant_id', tenantId);
  await admin
    .from('attendance_office_assignments')
    .delete()
    .eq('tenant_id', tenantId);
  await admin
    .from('attendance_office_rules')
    .delete()
    .eq('tenant_id', tenantId);
  await admin.from('attendance_offices').delete().eq('tenant_id', tenantId);
  await admin
    .from('attendance_setup_progress')
    .delete()
    .eq('tenant_id', tenantId);
  await admin.from('attendance_onboarding').delete().eq('tenant_id', tenantId);
  await admin
    .from('attendance_weekly_off_defaults')
    .delete()
    .eq('tenant_id', tenantId);
  await admin.from('attendance_settings').delete().eq('tenant_id', tenantId);
  await admin.from('tenants').delete().eq('id', tenantId);
  const del = await admin.from('users').delete().in('id', crew);
  if (del.error) throw new Error(`users leak: ${del.error.message}`);
}
