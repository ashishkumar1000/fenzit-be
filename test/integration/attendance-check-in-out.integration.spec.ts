/**
 * Story 16-1 + 16-2 real-DB journey probe (Epic 16 — check-in & check-out).
 *
 * Drives the SHIPPED CheckInOutService (real pg pool, real transactions,
 * the real AD-5 lock helpers and attendance_today) against a REAL database
 * — the mocked unit specs pin the decisions, this proves the SQL, the
 * constraints, the deferred triggers and the notification dedupe index
 * behind them.
 *
 * Requires real credentials: gated on DATABASE_URL being set and not the
 * jest.env.setup.ts dummy (15-7 harness convention). Fixtures are
 * self-contained (throwaway tenant keyed by unique probe phones) and
 * removed in afterAll.
 */
import { Pool } from 'pg';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { PgPoolFactory } from '../../src/common/pg/pg-pool.factory';
import { SupabaseClientFactory } from '../../src/common/factories/supabase-client.factory';
import { EnrolmentsService } from '../../src/attendance/enrolments.service';
import { ReassignOfficeDto } from '../../src/attendance/dto/enrolment.dto';
import { CheckInOutService } from '../../src/attendance/check-in-out.service';
import { CheckInOutDto } from '../../src/attendance/dto/check-in-out.dto';
import {
  attendanceRecordsExist,
  hasCheckInOn,
} from '../../src/attendance/enrolments.repository';

const DATABASE_URL = process.env['DATABASE_URL'] ?? '';
const SUPABASE_URL = process.env['SUPABASE_URL'] ?? '';
const SUPABASE_SERVICE_ROLE_KEY =
  process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';
const SUPABASE_ANON_KEY = process.env['SUPABASE_ANON_KEY'] ?? '';
const IS_REAL_DB =
  DATABASE_URL !== '' &&
  !DATABASE_URL.includes('test:test') &&
  SUPABASE_URL !== '' &&
  !SUPABASE_URL.includes('test.supabase.co');

const TENANT = randomUUID();
const OWNER = randomUUID();
const TECH_MAIN = randomUUID();
const TECH_WEEKLY = randomUUID();
const TECH_HOLIDAY = randomUUID();
const TECH_RATE = randomUUID();
const TECH_OUT = randomUUID();
/** Never enrolled — the office_id-null path (review HIGH finding). */
const TECH_NEW = randomUUID();
const OFFICE = randomUUID();
const OFFICE_B = randomUUID();
const RULE = randomUUID();
/** Rule 00:00–23:59 IST, cut-off 0 — late/early become deterministic
 * functions of the (server-chosen) instant: late = checkinMinute,
 * early = 1439 − checkoutMinute. */
const RULE_START_MINUTE = 0;
const RULE_END_MINUTE = 23 * 60 + 59;
const ALL_TECHS = [TECH_MAIN, TECH_WEEKLY, TECH_HOLIDAY, TECH_RATE, TECH_OUT];

/** Seven unique probe phones — [0] for the owner, [1..6] for the techs
 * (phones are unique per tenant, and the owner joins the tenant). */
const PROBE_PHONES = [0, 1, 2, 3, 4, 5, 6].map(
  (i) => `7${Date.now()}1${i}`.slice(-10),
);

const OFFICE_PIN = { lat: 12.97, lng: 77.59 };
/** ~45 m from the pin — inside the 100 m radius. */
const IN_RADIUS = { latitude: 12.9703, longitude: 77.5903 };
const DELHI = { latitude: 28.6139, longitude: 77.209 };

function fix(overrides: Partial<CheckInOutDto> = {}): CheckInOutDto {
  return Object.assign(new CheckInOutDto(), {
    latitude: IN_RADIUS.latitude,
    longitude: IN_RADIUS.longitude,
    accuracyM: 8,
    mocked: false,
    provider: 'fused',
    fixAgeMs: 500,
    ...overrides,
  });
}

function isoWeekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1;
}

function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Minute-of-day read STRAIGHT off the tenant-offset instant string —
 * no runner-timezone parsing anywhere. */
function minuteOfOffsetInstant(offsetIso: string): number {
  const [h, m] = offsetIso.slice(11, 16).split(':').map(Number);
  return h * 60 + m;
}

describe('Attendance check-in/out journey (16-1/16-2, real DB)', () => {
  const maybeIt = IS_REAL_DB ? it : it.skip;
  let pool: Pool;
  let admin: SupabaseClient;
  let service: CheckInOutService;
  let servicePool: PgPoolFactory;
  let today: string;

  async function inTx<T>(
    work: (tx: import('pg').PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const result = await work(client);
      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Enrolment + assignment in ONE transaction — the deferred coverage
   * trigger validates at COMMIT, so the admin client (autocommit) cannot
   * insert them separately. enabled_at a week ago keeps the FR-2 grace
   * out of the journey (it has dedicated unit coverage). */
  async function enroll(employeeId: string): Promise<void> {
    await inTx(async (tx) => {
      const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
      await tx.query(
        `insert into public.attendance_enrolments (tenant_id, employee_id, valid, enabled_at)
         values ($1, $2, daterange(current_date - 7, null, '[)'), $3)`,
        [TENANT, employeeId, weekAgo],
      );
      await tx.query(
        `insert into public.attendance_office_assignments (tenant_id, employee_id, office_id, valid)
         values ($1, $2, $3, daterange(current_date - 7, null, '[)'))`,
        [TENANT, employeeId, OFFICE],
      );
    });
  }

  async function attemptCount(employeeId: string, outcome?: string): Promise<number> {
    const r = outcome
      ? await pool.query(
          'select count(*)::int as n from public.attendance_attempts where employee_id = $1 and outcome = $2',
          [employeeId, outcome],
        )
      : await pool.query(
          'select count(*)::int as n from public.attendance_attempts where employee_id = $1',
          [employeeId],
        );
    return r.rows[0].n;
  }

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
    servicePool = new PgPoolFactory({
      getOrThrow: (key: string) => {
        if (key === 'DATABASE_URL') return DATABASE_URL;
        throw new Error(`Unexpected config key ${key}`);
      },
    } as unknown as ConfigService);
    service = new CheckInOutService(servicePool);

    // Pre-clean leftovers from an aborted earlier run (same probe phones).
    const { data: stale } = await admin
      .from('users')
      .select('id, tenant_id')
      .in('phone_number', PROBE_PHONES);
    if (stale && stale.length > 0) {
      const staleTenants = [
        ...new Set(stale.map((s) => s.tenant_id).filter(Boolean)),
      ] as string[];
      for (const t of staleTenants) {
        await admin.from('attendance_records').delete().eq('tenant_id', t);
        await admin.from('attendance_attempts').delete().eq('tenant_id', t);
        await admin.from('notifications').delete().eq('tenant_id', t);
        await admin.from('holidays').delete().eq('tenant_id', t);
        await admin
          .from('attendance_weekly_off_overrides')
          .delete()
          .eq('tenant_id', t);
        await admin
          .from('attendance_weekly_off_defaults')
          .delete()
          .eq('tenant_id', t);
        await admin.from('attendance_enrolments').delete().eq('tenant_id', t);
        await admin
          .from('attendance_office_assignments')
          .delete()
          .eq('tenant_id', t);
        await admin.from('attendance_onboarding').delete().eq('tenant_id', t);
        await admin
          .from('attendance_setup_progress')
          .delete()
          .eq('tenant_id', t);
        await admin.from('attendance_settings').delete().eq('tenant_id', t);
        await admin.from('attendance_offices').delete().eq('tenant_id', t);
        await admin.from('tenants').delete().eq('id', t);
      }
      await admin
        .from('users')
        .delete()
        .in('id', stale.map((s) => s.id));
    }

    const must = <T>(
      res: { data: T | null; error: { message: string } | null },
    ): T => {
      if (res.error) {
        throw new Error(`fixture insert failed: ${res.error.message}`);
      }
      return res.data as T;
    };

    must(
      await admin.from('users').insert({
        id: OWNER,
        role: 'owner',
        status: 'active',
        country_code: '+91',
        phone_number: PROBE_PHONES[0],
        name: '16-x probe owner',
      }),
    );
    must(
      await admin.from('tenants').insert({
        id: TENANT,
        owner_id: OWNER,
        company_name: '16-x journey probe',
        state_code: 'KA',
      }),
    );
    await admin.from('users').update({ tenant_id: TENANT }).eq('id', OWNER);
    must(
      await admin.from('users').insert([
        ...ALL_TECHS.map((id, i) => ({
          id,
          tenant_id: TENANT,
          role: 'technician',
          status: 'active',
          country_code: '+91',
          phone_number: PROBE_PHONES[i + 1],
          name: `16-x probe tech ${i}`,
        })),
        {
          id: TECH_NEW,
          tenant_id: TENANT,
          role: 'technician',
          status: 'active',
          country_code: '+91',
          phone_number: PROBE_PHONES[6],
          name: '16-x probe tech (never enrolled)',
        },
      ]),
    );
    must(
      await admin.from('attendance_offices').insert([
        {
          id: OFFICE,
          tenant_id: TENANT,
          name: 'probe office 16x',
          latitude: OFFICE_PIN.lat,
          longitude: OFFICE_PIN.lng,
          radius_m: 100,
        },
        {
          id: OFFICE_B,
          tenant_id: TENANT,
          name: 'probe office 16x B',
          latitude: 12.98,
          longitude: 77.6,
          radius_m: 100,
        },
      ]),
    );
    must(
      await admin.from('attendance_office_rules').insert({
        id: RULE,
        tenant_id: TENANT,
        office_id: OFFICE,
        valid: '[2026-01-01,)',
        start_time: '00:00:00',
        end_time: '23:59:00',
        late_cutoff_minutes: 0,
        full_day_hours: 8,
        half_day_hours: 4,
      }),
    );
    for (const tech of ALL_TECHS) {
      await enroll(tech);
    }

    const t = await pool.query(
      'select public.attendance_today($1)::text as today',
      [TENANT],
    );
    today = t.rows[0].today;
  });

  afterAll(async () => {
    if (!IS_REAL_DB) return;
    await admin.from('attendance_records').delete().eq('tenant_id', TENANT);
    await admin.from('attendance_attempts').delete().eq('tenant_id', TENANT);
    await admin.from('notifications').delete().eq('tenant_id', TENANT);
    await admin.from('holidays').delete().eq('tenant_id', TENANT);
    await admin
      .from('attendance_weekly_off_overrides')
      .delete()
      .eq('tenant_id', TENANT);
    await admin
      .from('attendance_weekly_off_defaults')
      .delete()
      .eq('tenant_id', TENANT);
    await admin.from('attendance_enrolments').delete().eq('tenant_id', TENANT);
    await admin
      .from('attendance_office_assignments')
      .delete()
      .eq('tenant_id', TENANT);
    await admin.from('attendance_onboarding').delete().eq('tenant_id', TENANT);
    await admin
      .from('attendance_setup_progress')
      .delete()
      .eq('tenant_id', TENANT);
    await admin.from('attendance_settings').delete().eq('tenant_id', TENANT);
    await admin.from('attendance_offices').delete().eq('tenant_id', TENANT);
    await admin.from('users').delete().in('id', [OWNER, ...ALL_TECHS, TECH_NEW]);
    await admin.from('tenants').delete().eq('id', TENANT);
    await servicePool.onModuleDestroy();
    await pool.end();
  });

  maybeIt('check-in before setup completion records not_tracked (403 + committed attempt)', async () => {
    const key = randomUUID();
    const err = await service
      .checkIn(
        { userId: TECH_MAIN, tenantId: TENANT, role: 'technician', rawJwt: 'x' },
        fix(),
        key,
      )
      .then(
        () => null,
        (e) => e,
      );
    expect(err).toMatchObject({ status: 403 });
    expect((err.getResponse() as Record<string, unknown>)['error_code']).toBe(
      'ATTENDANCE_NOT_TRACKED',
    );
    const r = await pool.query(
      'select outcome from public.attendance_attempts where request_id = $1',
      [key],
    );
    expect(r.rows[0].outcome).toBe('not_tracked');
  });

  maybeIt('a NEVER-ENROLLED technician reads a clean not_tracked 403 (review HIGH: the day-context rule query must not crash on a missing office)', async () => {
    const key = randomUUID();
    const err = await service
      .checkIn(
        { userId: TECH_NEW, tenantId: TENANT, role: 'technician', rawJwt: 'x' },
        fix(),
        key,
      )
      .then(
        () => null,
        (e) => e,
      );
    expect(err).toMatchObject({ status: 403 });
    expect((err.getResponse() as Record<string, unknown>)['error_code']).toBe(
      'ATTENDANCE_NOT_TRACKED',
    );
    const r = await pool.query(
      'select outcome from public.attendance_attempts where request_id = $1',
      [key],
    );
    expect(r.rows[0].outcome).toBe('not_tracked');
  });

  maybeIt('the accepted check-in snapshots every AD-9 column and computes late from the stored instant', async () => {
    // Settings row = setup completed + enabled (the wizard wrote these in 15-2).
    await admin.from('attendance_settings').insert({
      tenant_id: TENANT,
      enabled: true,
      setup_completed_at: new Date().toISOString(),
    });

    const key = randomUUID();
    const response = await service.checkIn(
      { userId: TECH_MAIN, tenantId: TENANT, role: 'technician', rawJwt: 'x' },
      fix(),
      key,
    );

    expect(response.workDate).toBe(today);
    expect(response.checkinAt).toMatch(/\+05:30$/);
    expect(response.dayContext).toEqual({
      isWeeklyOff: false,
      isHoliday: false,
      holidayName: null,
      isWorkingDay: true,
    });
    // Rule 00:00 + cut-off 0 → late minutes = the check-in's local minute.
    expect(response.lateMinutes).toBe(minuteOfOffsetInstant(response.checkinAt));
    expect(response.isLate).toBe(true);

    const r = await pool.query(
      `select office_id, office_rules_id::text as rule_id, radius_m,
              checkin_lat, checkin_lng, checkin_accuracy_m, checkin_distance_m,
              checkin_mocked, checkin_provider, checkin_attempt_id is not null as has_attempt,
              checkout_at
       from public.attendance_records
       where employee_id = $1 and work_date = $2::date`,
      [TECH_MAIN, today],
    );
    expect(r.rows).toHaveLength(1);
    const row = r.rows[0];
    expect(row.office_id).toBe(OFFICE);
    expect(row.rule_id).toBe(RULE);
    expect(row.radius_m).toBe(100);
    expect(row.checkin_lat).toBeCloseTo(IN_RADIUS.latitude, 5);
    expect(row.checkin_lng).toBeCloseTo(IN_RADIUS.longitude, 5);
    expect(row.checkin_accuracy_m).toBe(8);
    expect(row.checkin_distance_m).toBeGreaterThan(20);
    expect(row.checkin_distance_m).toBeLessThan(80);
    expect(row.checkin_mocked).toBe(false);
    expect(row.checkin_provider).toBe('fused');
    expect(row.has_attempt).toBe(true);
    expect(row.checkout_at).toBeNull();
  });

  maybeIt('a replayed key answers identically and writes nothing (AD-6)', async () => {
    // Reuse the key from the accepted check-in: re-derive it from the row.
    const { rows } = await pool.query(
      `select a.request_id, r.checkin_at
       from public.attendance_records r
       join public.attendance_attempts a on a.id = r.checkin_attempt_id
       where r.employee_id = $1`,
      [TECH_MAIN],
    );
    const key = rows[0].request_id as string;

    const replay = await service.checkIn(
      { userId: TECH_MAIN, tenantId: TENANT, role: 'technician', rawJwt: 'x' },
      fix(),
      key,
    );
    expect(replay.workDate).toBe(today);
    // The offset string truncates to seconds; the pg instant carries ms.
    expect(Math.floor(new Date(replay.checkinAt).getTime() / 1000)).toBe(
      Math.floor(new Date(rows[0].checkin_at).getTime() / 1000),
    );

    const c = await pool.query(
      'select count(*)::int as n from public.attendance_attempts where request_id = $1',
      [key],
    );
    expect(c.rows[0].n).toBe(1);
  });

  maybeIt('a second check-in on the same day records already_checked_in (409, not counted)', async () => {
    const key = randomUUID();
    const err = await service
      .checkIn(
        { userId: TECH_MAIN, tenantId: TENANT, role: 'technician', rawJwt: 'x' },
        fix(),
        key,
      )
      .then(
        () => null,
        (e) => e,
      );
    expect(err).toMatchObject({ status: 409 });
    expect((err.getResponse() as Record<string, unknown>)['error_code']).toBe(
      'ATTENDANCE_ALREADY_CHECKED_IN',
    );
    expect(await attemptCount(TECH_MAIN, 'already_checked_in')).toBe(1);
    // Not a counted outcome — the AD-15 budget stays at zero.
    const c = await pool.query(
      `select count(*)::int as n from public.attendance_attempts
       where employee_id = $1 and outcome = any(array['too_far','low_accuracy','mocked','stale_fix'])`,
      [TECH_MAIN],
    );
    expect(c.rows[0].n).toBe(0);
  });

  maybeIt('a weekly-off day still allows check-in (FR-7), flagged in the response', async () => {
    const weekday = isoWeekdayOf(today);
    await admin.from('attendance_weekly_off_overrides').insert({
      tenant_id: TENANT,
      employee_id: TECH_WEEKLY,
      valid: `[${today},${addDays(today, 1)})`,
      days: [weekday],
    });
    try {
      const response = await service.checkIn(
        {
          userId: TECH_WEEKLY,
          tenantId: TENANT,
          role: 'technician',
          rawJwt: 'x',
        },
        fix(),
        randomUUID(),
      );
      expect(response.dayContext.isWeeklyOff).toBe(true);
      expect(response.dayContext.isWorkingDay).toBe(false);
    } finally {
      await admin
        .from('attendance_weekly_off_overrides')
        .delete()
        .eq('tenant_id', TENANT);
    }
  });

  maybeIt('a holiday still allows check-in (FR-7), carrying the holiday name', async () => {
    await admin
      .from('holidays')
      .insert({ tenant_id: TENANT, holiday_date: today, name: 'Probe Diwali' });
    try {
      const response = await service.checkIn(
        {
          userId: TECH_HOLIDAY,
          tenantId: TENANT,
          role: 'technician',
          rawJwt: 'x',
        },
        fix(),
        randomUUID(),
      );
      expect(response.dayContext.isHoliday).toBe(true);
      expect(response.dayContext.holidayName).toBe('Probe Diwali');
      expect(response.dayContext.isWorkingDay).toBe(false);
    } finally {
      await admin.from('holidays').delete().eq('tenant_id', TENANT);
    }
  });

  maybeIt('too_far carries distanceM/radiusM and keeps the coordinates on the attempt row', async () => {
    const key = randomUUID();
    const err = await service
      .checkIn(
        { userId: TECH_RATE, tenantId: TENANT, role: 'technician', rawJwt: 'x' },
        fix({ ...DELHI }),
        key,
      )
      .then(
        () => null,
        (e) => e,
      );
    expect(err).toMatchObject({ status: 422 });
    const body = err.getResponse() as Record<string, unknown>;
    expect(body['error_code']).toBe('ATTENDANCE_TOO_FAR');
    expect(body['radiusM']).toBe(100);
    expect(body['distanceM'] as number).toBeGreaterThan(1_000_000);

    const r = await pool.query(
      'select latitude, longitude, distance_m, radius_m from public.attendance_attempts where request_id = $1',
      [key],
    );
    expect(r.rows[0].latitude).toBeCloseTo(DELHI.latitude, 5);
    expect(r.rows[0].distance_m).not.toBeNull();

    // A replay of the rejected key answers the same rejection, no new row.
    const before = await attemptCount(TECH_RATE);
    const replayErr = await service
      .checkIn(
        { userId: TECH_RATE, tenantId: TENANT, role: 'technician', rawJwt: 'x' },
        fix({ ...DELHI }),
        key,
      )
      .then(
        () => null,
        (e) => e,
      );
    expect((replayErr.getResponse() as Record<string, unknown>)['error_code']).toBe(
      'ATTENDANCE_TOO_FAR',
    );
    expect(await attemptCount(TECH_RATE)).toBe(before);
  });

  maybeIt('low_accuracy lands as its own counted outcome', async () => {
    await expect(
      service.checkIn(
        { userId: TECH_RATE, tenantId: TENANT, role: 'technician', rawJwt: 'x' },
        fix({ accuracyM: 150 }),
        randomUUID(),
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect(await attemptCount(TECH_RATE, 'low_accuracy')).toBe(1);
  });

  maybeIt('stale_fix is its own counted outcome (probed on TECH_OUT, whose budget stays under the limit)', async () => {
    await expect(
      service.checkIn(
        { userId: TECH_OUT, tenantId: TENANT, role: 'technician', rawJwt: 'x' },
        fix({ fixAgeMs: 40_000 }),
        randomUUID(),
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect(await attemptCount(TECH_OUT, 'stale_fix')).toBe(1);
  });

  maybeIt('the 3rd mocked attempt of the month alerts the owner exactly once (AD-13)', async () => {
    // Budget plan on TECH_RATE: too_far(1) + low_accuracy(2) are already
    // recorded, so mocked #1..#3 are counted 3..5 — the 3rd mocked is
    // exactly the 5th counted rejection (alert + block arm together, the
    // strictest ordering the two budgets can produce).
    let alerts = await admin
      .from('notifications')
      .select('*')
      .eq('tenant_id', TENANT)
      .eq('event_type', 'attendance.fake_location');
    expect(alerts.data).toHaveLength(0);

    // Mocked #1 and #2 (counted 3 and 4): no alert, no block.
    for (let i = 0; i < 2; i++) {
      await expect(
        service.checkIn(
          {
            userId: TECH_RATE,
            tenantId: TENANT,
            role: 'technician',
            rawJwt: 'x',
          },
          fix({ mocked: true }),
          randomUUID(),
        ),
      ).rejects.toMatchObject({ status: 422 });
    }
    alerts = await admin
      .from('notifications')
      .select('*')
      .eq('tenant_id', TENANT)
      .eq('event_type', 'attendance.fake_location');
    expect(alerts.data).toHaveLength(0);

    // Mocked #3 (the 5th counted rejection → also arms the block).
    const err = await service
      .checkIn(
        { userId: TECH_RATE, tenantId: TENANT, role: 'technician', rawJwt: 'x' },
        fix({ mocked: true }),
        randomUUID(),
      )
      .then(
        () => null,
        (e) => e,
      );
    expect(err).toMatchObject({ status: 422 });

    alerts = await admin
      .from('notifications')
      .select('*')
      .eq('tenant_id', TENANT)
      .eq('event_type', 'attendance.fake_location');
    expect(alerts.data).toHaveLength(1);
    const alert = alerts.data![0];
    expect(alert.payload['employeeName']).toBe('16-x probe tech 3');
    expect(alert.payload['attemptCount']).toBe(3);
    expect(alert.payload['month']).toMatch(/^\d{4}-\d{2}$/);
    expect(alert.dedupe_key).toBe(
      `${TENANT}:attendance.fake_location:${OWNER}:${TECH_RATE}:${alert.payload['month']}`,
    );
    expect(alert.entity_type).toBe('attendance');
    expect(alert.entity_id).toBe(TECH_RATE);

    // The same attempt row also carries the armed block (5th counted).
    const blocked = await pool.query(
      `select blocked_until from public.attendance_attempts
       where employee_id = $1 and blocked_until is not null`,
      [TECH_RATE],
    );
    expect(blocked.rows).toHaveLength(1);
    expect(new Date(blocked.rows[0].blocked_until).getTime()).toBeGreaterThan(
      Date.now() - 1000,
    );
  });

  maybeIt('while blocked: 429 + Retry-After, recorded but never counted (AD-15)', async () => {
    const err = await service
      .checkIn(
        { userId: TECH_RATE, tenantId: TENANT, role: 'technician', rawJwt: 'x' },
        fix(),
        randomUUID(),
      )
      .then(
        () => null,
        (e) => e,
      );
    expect(err).toMatchObject({ status: 429 });
    expect(
      (err.getResponse() as Record<string, unknown>)['retryAfterSeconds'],
    ).toBeGreaterThan(0);
    expect(await attemptCount(TECH_RATE, 'rate_limited')).toBe(1);
    // Counted budget unchanged at 5 (rate_limited rows do not count).
    const c = await pool.query(
      `select count(*)::int as n from public.attendance_attempts
       where employee_id = $1 and outcome = any(array['too_far','low_accuracy','mocked','stale_fix'])`,
      [TECH_RATE],
    );
    expect(c.rows[0].n).toBe(5);
  });

  maybeIt('after the window passes the employee can check in again', async () => {
    await pool.query(
      `update public.attendance_attempts
       set attempted_at = attempted_at - interval '11 minutes',
           blocked_until = blocked_until - interval '11 minutes'
       where employee_id = $1`,
      [TECH_RATE],
    );
    const response = await service.checkIn(
      { userId: TECH_RATE, tenantId: TENANT, role: 'technician', rawJwt: 'x' },
      fix(),
      randomUUID(),
    );
    expect(response.workDate).toBe(today);
  });

  maybeIt('check-out without a check-in records not_checked_in (409)', async () => {
    const err = await service
      .checkOut(
        { userId: TECH_OUT, tenantId: TENANT, role: 'technician', rawJwt: 'x' },
        fix(),
        randomUUID(),
      )
      .then(
        () => null,
        (e) => e,
      );
    expect(err).toMatchObject({ status: 409 });
    expect((err.getResponse() as Record<string, unknown>)['error_code']).toBe(
      'ATTENDANCE_NOT_CHECKED_IN',
    );
  });

  maybeIt('check-out updates the SAME row and reports worked minutes + early checkout', async () => {
    await service.checkIn(
      { userId: TECH_OUT, tenantId: TENANT, role: 'technician', rawJwt: 'x' },
      fix(),
      randomUUID(),
    );
    const response = await service.checkOut(
      { userId: TECH_OUT, tenantId: TENANT, role: 'technician', rawJwt: 'x' },
      fix(),
      randomUUID(),
    );

    expect(response.workDate).toBe(today);
    expect(response.checkoutAt).toMatch(/\+05:30$/);
    expect(response.earlyCheckout).toBe(true);
    expect(response.earlyCheckoutMinutes).toBe(
      RULE_END_MINUTE - minuteOfOffsetInstant(response.checkoutAt),
    );
    expect(response.workedMinutes).toBe(
      minuteOfOffsetInstant(response.checkoutAt) -
        minuteOfOffsetInstant(response.checkinAt),
    );

    const r = await pool.query(
      'select count(*)::int as n from public.attendance_records where employee_id = $1',
      [TECH_OUT],
    );
    expect(r.rows[0].n).toBe(1); // SAME row, not a second one
    const row = await pool.query(
      `select checkout_at, checkout_attempt_id, checkout_lat, checkout_distance_m
       from public.attendance_records where employee_id = $1`,
      [TECH_OUT],
    );
    expect(row.rows[0].checkout_at).not.toBeNull();
    expect(row.rows[0].checkout_attempt_id).not.toBeNull();
    expect(row.rows[0].checkout_lat).toBeCloseTo(IN_RADIUS.latitude, 5);
  });

  maybeIt('a second check-out records already_checked_out (409)', async () => {
    const err = await service
      .checkOut(
        { userId: TECH_OUT, tenantId: TENANT, role: 'technician', rawJwt: 'x' },
        fix(),
        randomUUID(),
      )
      .then(
        () => null,
        (e) => e,
      );
    expect(err).toMatchObject({ status: 409 });
    expect((err.getResponse() as Record<string, unknown>)['error_code']).toBe(
      'ATTENDANCE_ALREADY_CHECKED_OUT',
    );
  });

  maybeIt('FR-6 primitives self-activate: a checked-in employee now blocks same-day reassignment', async () => {
    const active = await inTx(async (tx) => ({
      recordsExist: await attendanceRecordsExist(tx),
      checkedIn: await hasCheckInOn(tx, TECH_MAIN, today),
      notCheckedIn: await hasCheckInOn(tx, TECH_WEEKLY, today),
    }));
    expect(active.recordsExist).toBe(true);
    expect(active.checkedIn).toBe(true);
    // TECH_WEEKLY checked in on their weekly-off probe — also counts.
    expect(active.notCheckedIn).toBe(true);
  });

  maybeIt('FR-6 at the endpoint level: reassigning a CHECKED-IN employee applies from tomorrow', async () => {
    const config = {
      getOrThrow: (key: string) => {
        if (key === 'DATABASE_URL') return DATABASE_URL;
        if (key === 'SUPABASE_URL') return SUPABASE_URL;
        if (key === 'SUPABASE_ANON_KEY') return SUPABASE_ANON_KEY;
        if (key === 'SUPABASE_SERVICE_ROLE_KEY') return SUPABASE_SERVICE_ROLE_KEY;
        throw new Error(`Unexpected config key ${key}`);
      },
    } as unknown as ConfigService;
    const enrolments = new EnrolmentsService(
      new SupabaseClientFactory(config),
      servicePool,
    );
    const dto = Object.assign(new ReassignOfficeDto(), {
      officeId: OFFICE_B,
      effectiveFrom: today,
    });
    const state = await enrolments.reassignOffice(
      { userId: OWNER, tenantId: TENANT, role: 'owner', rawJwt: 'x' },
      TECH_MAIN,
      dto,
    );
    // The view still anchors TODAY's office — FR-6 means the change only
    // applies from tomorrow.
    expect(state.officeId).toBe(OFFICE);
    const r = await pool.query(
      `select lower(valid)::text as start from public.attendance_office_assignments
       where employee_id = $1 and office_id = $2`,
      [TECH_MAIN, OFFICE_B],
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].start).toBe(addDays(today, 1));
  });

  maybeIt('RLS denies anon/authenticated on both new tables (no policies, 15-7 hygiene)', async () => {
    if (!SUPABASE_ANON_KEY) {
      console.warn('anon key absent — RLS probe skipped');
      return;
    }
    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    // REVOKE ALL → even SELECT errors for anon (15-7 grants hygiene).
    const read = await anon.from('attendance_records').select('*');
    expect(read.error).not.toBeNull();
    // …and INSERT is rejected too.
    const write = await anon.from('attendance_attempts').insert({
      tenant_id: TENANT,
      employee_id: TECH_MAIN,
      request_id: randomUUID(),
      kind: 'check_in',
      outcome: 'ok',
    });
    expect(write.error).not.toBeNull();
  });
});
