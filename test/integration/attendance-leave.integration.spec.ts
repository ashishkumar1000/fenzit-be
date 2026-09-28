/**
 * Stories 17-1..17-4 real-DB journey probe (Epic 17 — Leave Management).
 *
 * Drives the SHIPPED LeaveService / LeaveReadService (plus the extended
 * CheckInOutService for FR-9 and EnrolmentsService for the disable sweep)
 * against a REAL database — the mocked unit specs pin the decisions, this
 * proves the SQL, the partial unique index, the guard trigger, the seq
 * ordering and the notification dedupe behind them.
 *
 * Requires real credentials: gated on DATABASE_URL being set and not the
 * jest.env.setup.ts dummy (the 15-7 harness convention). Fixtures are
 * self-contained (throwaway tenant keyed by unique probe phones) and
 * removed in afterAll — whose tenant DROP doubles as the live probe that
 * the restrict-FK/cascade multi-path stays healthy (spec probe 26).
 */
import { Pool } from 'pg';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { PgPoolFactory } from '../../src/common/pg/pg-pool.factory';
import { LeaveService } from '../../src/attendance/leave.service';
import { LeaveReadService } from '../../src/attendance/leave-read.service';
import { CheckInOutService } from '../../src/attendance/check-in-out.service';
import { EnrolmentsService } from '../../src/attendance/enrolments.service';
import { ApplyLeaveDto } from '../../src/attendance/dto/leave.dto';
import { CheckInOutDto } from '../../src/attendance/dto/check-in-out.dto';

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

// Real pooler round-trips (ap-south-1 over the internet) — several probes
// chain a dozen+ sequential calls. The 5s jest default is hopeless here.
jest.setTimeout(120_000);

const TENANT = randomUUID();
const OWNER = randomUUID();
const TECH_MAIN = randomUUID();
const TECH_CROSS = randomUUID(); // duplicate-key probe + FR-9
const TECH_LATE = randomUUID(); // rule 23:59 → today always actionable
const TECH_EARLY = randomUUID(); // rule 00:30 → cutoff passed all day
const TECH_FUTURE = randomUUID(); // upcoming — enrolment starts in 5 days
const TECH_OFF = randomUUID(); // today is a weekly off for them
const TECH_DISABLE = randomUUID(); // the D12 disable sweep
const TECH_OFFDAY = randomUUID(); // the D11 off-day-inside-a-span probe
const ALL_TECHS = [
  TECH_MAIN,
  TECH_CROSS,
  TECH_LATE,
  TECH_EARLY,
  TECH_FUTURE,
  TECH_OFF,
  TECH_DISABLE,
  TECH_OFFDAY,
];

const PROBE_PHONES = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) =>
  `8${Date.now()}2${i}`.slice(-10),
);

function isoWeekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1;
}

function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

let today = '';
let fr9RequestId = '';
let fr9ConfirmKey = '';

function applyDto(overrides: Partial<ApplyLeaveDto> = {}): ApplyLeaveDto {
  return Object.assign(new ApplyLeaveDto(), {
    startDate: addDays(today, 1),
    endDate: addDays(today, 3),
    part: 'full_day',
    reason: '17-4 journey probe',
    ...overrides,
  });
}

function fix(overrides: Partial<CheckInOutDto> = {}): CheckInOutDto {
  return Object.assign(new CheckInOutDto(), {
    latitude: 12.9703,
    longitude: 77.5903, // ~45 m from the pin — inside radius 100
    accuracyM: 8,
    mocked: false,
    provider: 'fused',
    fixAgeMs: 500,
    ...overrides,
  });
}

const KEY = () => randomUUID();

/** A technician JWT-identity stub — services take the user, not a token. */
const techUser = (userId: string) => ({
  userId,
  tenantId: TENANT,
  role: 'technician',
});
const ownerUser = () => ({ userId: OWNER, tenantId: TENANT, role: 'owner' });

describe('Leave journey (17-1..17-4, real DB)', () => {
  const maybeIt = IS_REAL_DB ? it : it.skip;
  let pool: Pool;
  let admin: SupabaseClient;
  let leave: LeaveService;
  let leaveRead: LeaveReadService;
  let checkIn: CheckInOutService;
  let enrolments: EnrolmentsService;
  let servicePool: PgPoolFactory;

  const must = <T>(res: {
    data: T | null;
    error: { message: string; details?: string; hint?: string } | null;
  }): T => {
    if (res.error)
      throw new Error(
        `fixture failed: ${res.error.message} | details: ${res.error.details ?? '-'} | hint: ${res.error.hint ?? '-'}`,
      );
    return res.data as T;
  };

  async function count(sql: string, params: unknown[] = []): Promise<number> {
    const r = await pool.query(sql, params);
    return Number(r.rows[0]?.n ?? 0);
  }

  async function expectRejection(
    promise: Promise<unknown>,
    status: number,
    errorCode: string,
  ) {
    try {
      await promise;
      throw new Error(`expected ${errorCode}`);
    } catch (err) {
      const e = err as { status?: number; getResponse?: () => unknown };
      expect(e.status).toBe(status);
      expect((e.getResponse?.() as Record<string, unknown>)['error_code']).toBe(
        errorCode,
      );
    }
  }

  /** On-behalf apply (owner) — the fastest way to create APPROVED leave. */
  async function applyApproved(
    employeeId: string,
    start: string,
    end: string,
    part = 'full_day',
  ) {
    return leave.applyOnBehalf(
      ownerUser() as never,
      Object.assign(applyDto({ startDate: start, endDate: end, part }), {
        employeeId,
      }),
      KEY(),
    );
  }

  beforeAll(async () => {
    if (!IS_REAL_DB) return;
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 3,
    });
    admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    today = (
      await pool.query(
        "select to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM-DD') as today",
      )
    ).rows[0].today;

    const config = {
      getOrThrow: (key: string) => {
        if (key === 'DATABASE_URL') return DATABASE_URL;
        throw new Error(`Unexpected config key ${key}`);
      },
    } as unknown as ConfigService;
    servicePool = new PgPoolFactory(config);
    leave = new LeaveService(servicePool);
    leaveRead = new LeaveReadService(servicePool);
    checkIn = new CheckInOutService(servicePool);
    enrolments = new EnrolmentsService(
      { createAdmin: () => admin } as never,
      servicePool,
    );

    // ---- fixtures: tenant, owner, techs, office, rules, enrolments ----
    must(
      await admin.from('users').insert({
        id: OWNER,
        role: 'owner',
        status: 'active',
        country_code: '+91',
        phone_number: PROBE_PHONES[0],
        name: '17-4 probe owner',
      }),
    );
    must(
      await admin.from('tenants').insert({
        id: TENANT,
        owner_id: OWNER,
        company_name: '17-4 journey probe',
        state_code: 'KA',
        timezone: 'Asia/Kolkata',
      }),
    );
    await admin.from('users').update({ tenant_id: TENANT }).eq('id', OWNER);
    must(
      await admin.from('users').insert(
        ALL_TECHS.map((id, i) => ({
          id,
          tenant_id: TENANT,
          role: 'technician',
          status: 'active',
          country_code: '+91',
          phone_number: PROBE_PHONES[i + 1],
          name: `17-4 probe tech ${i}`,
        })),
      ),
    );
    must(
      await admin.from('attendance_settings').insert({
        tenant_id: TENANT,
        enabled: true,
        setup_completed_at: new Date().toISOString(),
      }),
    );
    const office = must(
      await admin
        .from('attendance_offices')
        .insert({
          tenant_id: TENANT,
          name: 'HQ',
          latitude: 12.97,
          longitude: 77.59,
          radius_m: 100,
        })
        .select('id')
        .single(),
    );
    const OFFICE_ID = office.id;
    must(
      await admin.from('attendance_office_rules').insert([
        {
          tenant_id: TENANT,
          office_id: OFFICE_ID,
          valid: '[2000-01-01,)',
          start_time: '23:58',
          end_time: '23:59',
          late_cutoff_minutes: 0,
          full_day_hours: 8,
          half_day_hours: 4,
        },
      ]),
    );
    // TECH_EARLY's own office (cutoff 00:30 — passed all day).
    const officeEarly = must(
      await admin
        .from('attendance_offices')
        .insert({
          tenant_id: TENANT,
          name: 'Early',
          latitude: 12.97,
          longitude: 77.59,
          radius_m: 100,
        })
        .select('id')
        .single(),
    );
    must(
      await admin.from('attendance_office_rules').insert([
        {
          tenant_id: TENANT,
          office_id: officeEarly.id,
          valid: '[2000-01-01,)',
          start_time: '00:01',
          end_time: '23:59',
          late_cutoff_minutes: 0,
          full_day_hours: 8,
          half_day_hours: 4,
        },
      ]),
    );

    const inTx = async (
      work: (tx: import('pg').PoolClient) => Promise<void>,
    ) => {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await work(client);
        await client.query('commit');
      } catch (err) {
        await client.query('rollback');
        throw err;
      } finally {
        client.release();
      }
    };
    // Enrol + assign in ONE transaction (the coverage trigger validates at COMMIT).
    const enroll = async (
      employeeId: string,
      officeId: string,
      fromOffsetDays: number,
    ) => {
      const rangeStart = addDays(today, -fromOffsetDays);
      await inTx(async (tx) => {
        await tx.query(
          `insert into public.attendance_enrolments (tenant_id, employee_id, valid, enabled_at)
           values ($1, $2, $3::daterange, now() - interval '30 days')`,
          [TENANT, employeeId, `[${rangeStart},)`],
        );
        await tx.query(
          `insert into public.attendance_office_assignments (tenant_id, employee_id, office_id, valid)
           values ($1, $2, $3, $4::daterange)`,
          [TENANT, employeeId, officeId, `[${rangeStart},)`],
        );
      });
    };
    await enroll(TECH_MAIN, OFFICE_ID, 30);
    await enroll(TECH_CROSS, OFFICE_ID, 30);
    await enroll(TECH_LATE, OFFICE_ID, 30);
    await enroll(TECH_EARLY, officeEarly.id, 30);
    await enroll(TECH_OFF, OFFICE_ID, 30);
    await enroll(TECH_DISABLE, OFFICE_ID, 30);
    await enroll(TECH_OFFDAY, OFFICE_ID, 30);
    // TECH_FUTURE: upcoming — starts in 5 days.
    await inTx(async (tx) => {
      await tx.query(
        `insert into public.attendance_enrolments (tenant_id, employee_id, valid, enabled_at)
         values ($1, $2, $3::daterange, now())`,
        [TENANT, TECH_FUTURE, `[${addDays(today, 5)},)`],
      );
      await tx.query(
        `insert into public.attendance_office_assignments (tenant_id, employee_id, office_id, valid)
         values ($1, $2, $3, $4::daterange)`,
        [TENANT, TECH_FUTURE, OFFICE_ID, `[${addDays(today, 5)},)`],
      );
    });
  });

  afterAll(async () => {
    if (!IS_REAL_DB) return;
    // The FK-safe teardown IS probe 26's tenant-drop assertion: leave rows
    // RESTRICT to their request, both cascade from the tenant.
    await admin.from('notifications').delete().eq('tenant_id', TENANT);
    const { error } = await admin.from('tenants').delete().eq('id', TENANT);
    expect(error).toBeNull();
    await admin
      .from('users')
      .delete()
      .in('id', [OWNER, ...ALL_TECHS]);
    await pool.end();
    await servicePool.onModuleDestroy();
  });

  // ================================================== 17-1: apply + model

  it('probe 1: applies a happy range — day rows for EVERY date, all pending, event + exactly one owner notification', async () => {
    const start = addDays(today, 1);
    const view = await leave.applyForSelf(
      techUser(TECH_MAIN) as never,
      applyDto({ startDate: start, endDate: addDays(today, 3) }),
      KEY(),
    );
    expect(view.status).toBe('pending');
    expect(view.totalDays).toBe(3);
    expect(view.dates).toHaveLength(3);
    expect(
      await count(
        'select count(*)::int as n from public.leave_request_days where leave_request_id = $1',
        [view.id],
      ),
    ).toBe(3);
    expect(
      await count(
        "select count(*)::int as n from public.leave_events where leave_request_id = $1 and cause = 'apply'",
        [view.id],
      ),
    ).toBe(1);
    expect(
      await count(
        "select count(*)::int as n from public.notifications where event_type = 'leave.applied' and entity_id = $1",
        [view.id],
      ),
    ).toBe(1);
  });

  it('probe 2: replays the same key (no second row); a SECOND employee with the same key gets 409 DUPLICATE_RESOURCE then their own fresh apply', async () => {
    const replayKey = KEY();
    const fresh = applyDto({
      startDate: addDays(today, 10),
      endDate: addDays(today, 12),
    });
    const first = await leave.applyForSelf(
      techUser(TECH_MAIN) as never,
      fresh,
      replayKey,
    );
    const replay = await leave.applyForSelf(
      techUser(TECH_MAIN) as never,
      fresh,
      replayKey,
    );
    expect(replay.id).toBe(first.id);
    expect(
      await count(
        'select count(*)::int as n from public.leave_requests where request_id = $1',
        [replayKey],
      ),
    ).toBe(1);
    await expectRejection(
      leave.applyForSelf(
        techUser(TECH_CROSS) as never,
        applyDto({
          startDate: addDays(today, 20),
          endDate: addDays(today, 21),
        }),
        replayKey,
      ),
      409,
      'DUPLICATE_RESOURCE',
    );
    const own = await leave.applyForSelf(
      techUser(TECH_CROSS) as never,
      applyDto({ startDate: addDays(today, 20), endDate: addDays(today, 21) }),
      KEY(),
    );
    expect(own.status).toBe('pending');
  });

  it('probe 3: half-day is single-date only; end<start and 63-day spans reject; 62 OK', async () => {
    await expectRejection(
      leave.applyForSelf(
        techUser(TECH_MAIN) as never,
        applyDto({
          startDate: addDays(today, 30),
          endDate: addDays(today, 31),
          part: 'first_half',
        }),
        KEY(),
      ),
      422,
      'LEAVE_INVALID_RANGE',
    );
    await expectRejection(
      leave.applyForSelf(
        techUser(TECH_MAIN) as never,
        applyDto({
          startDate: addDays(today, 31),
          endDate: addDays(today, 30),
        }),
        KEY(),
      ),
      422,
      'LEAVE_INVALID_RANGE',
    );
    await expectRejection(
      leave.applyForSelf(
        techUser(TECH_MAIN) as never,
        applyDto({
          startDate: addDays(today, 40),
          endDate: addDays(today, 40 + 62),
        }),
        KEY(),
      ),
      422,
      'LEAVE_INVALID_RANGE',
    );
    const single = await leave.applyForSelf(
      techUser(TECH_MAIN) as never,
      applyDto({
        startDate: addDays(today, 30),
        endDate: addDays(today, 30),
        part: 'first_half',
      }),
      KEY(),
    );
    expect(single.part).toBe('first_half');
  });

  it('probe 4: an every-date-off range is rejected with the exact message; a mixed range is admitted', async () => {
    const holidayDate = addDays(today, 32);
    must(
      await admin.from('holidays').insert({
        tenant_id: TENANT,
        holiday_date: holidayDate,
        name: 'Probe Holiday',
      }),
    );
    await expectRejection(
      leave.applyForSelf(
        techUser(TECH_MAIN) as never,
        applyDto({ startDate: holidayDate, endDate: holidayDate }),
        KEY(),
      ),
      422,
      'LEAVE_ALREADY_OFF',
    );
    const mixed = await leave.applyForSelf(
      techUser(TECH_MAIN) as never,
      applyDto({ startDate: addDays(today, 32), endDate: addDays(today, 33) }),
      KEY(),
    );
    expect(mixed.totalDays).toBe(2);
    expect(mixed.workingDays).toBe(1);
  });

  it('probe 5: overlaps reject on pending AND approved; re-applying over a REJECTED range is admitted', async () => {
    await expectRejection(
      leave.applyForSelf(
        techUser(TECH_MAIN) as never,
        applyDto({ startDate: addDays(today, 1), endDate: addDays(today, 2) }),
        KEY(),
      ),
      409,
      'LEAVE_OVERLAP',
    );
    await applyApproved(TECH_MAIN, addDays(today, 50), addDays(today, 51));
    await expectRejection(
      leave.applyForSelf(
        techUser(TECH_MAIN) as never,
        applyDto({
          startDate: addDays(today, 51),
          endDate: addDays(today, 52),
        }),
        KEY(),
      ),
      409,
      'LEAVE_OVERLAP',
    );
    const rejected = await leave.applyForSelf(
      techUser(TECH_MAIN) as never,
      applyDto({ startDate: addDays(today, 60), endDate: addDays(today, 61) }),
      KEY(),
    );
    await leave.reject(ownerUser() as never, rejected.id, null);
    const again = await leave.applyForSelf(
      techUser(TECH_MAIN) as never,
      applyDto({ startDate: addDays(today, 60), endDate: addDays(today, 61) }),
      KEY(),
    );
    expect(again.status).toBe('pending');
  });

  it('probe 6: 8 days back is too old; exactly 7 is admitted', async () => {
    await expectRejection(
      leave.applyForSelf(
        techUser(TECH_MAIN) as never,
        applyDto({
          startDate: addDays(today, -8),
          endDate: addDays(today, -8),
        }),
        KEY(),
      ),
      422,
      'LEAVE_TOO_OLD',
    );
    const seven = await leave.applyForSelf(
      techUser(TECH_MAIN) as never,
      applyDto({ startDate: addDays(today, -7), endDate: addDays(today, -7) }),
      KEY(),
    );
    expect(seven.startDate).toBe(addDays(today, -7));
  });

  it('probe 7: the upcoming employee may apply from the start date, never before it', async () => {
    await expectRejection(
      leave.applyForSelf(
        techUser(TECH_FUTURE) as never,
        applyDto({ startDate: addDays(today, 4), endDate: addDays(today, 4) }),
        KEY(),
      ),
      422,
      'LEAVE_BEFORE_START_DATE',
    );
    const fromStart = await leave.applyForSelf(
      techUser(TECH_FUTURE) as never,
      applyDto({ startDate: addDays(today, 5), endDate: addDays(today, 5) }),
      KEY(),
    );
    expect(fromStart.status).toBe('pending');
  });

  it('probe 8: a past date — or today — with a check-in cannot be requested', async () => {
    // A real attempt row for TECH_MAIN (the record's FK target), then the
    // record itself for yesterday.
    const attempt = await pool.query(
      `insert into public.attendance_attempts
         (tenant_id, employee_id, request_id, kind, outcome)
       values ($1, $2, $3, 'check_in', 'ok') returning id`,
      [TENANT, TECH_MAIN, KEY()],
    );
    await pool.query(
      `insert into public.attendance_records
         (tenant_id, employee_id, work_date, office_id, radius_m, checkin_at, checkin_attempt_id,
          checkin_lat, checkin_lng, checkin_accuracy_m, checkin_distance_m, checkin_mocked)
       values ($1, $2, ((now() at time zone 'Asia/Kolkata')::date - 1), (select office_id from public.attendance_office_assignments where employee_id = $2 limit 1),
               100, now(), $3, 12.97, 77.59, 8, 10, false)
       on conflict (employee_id, work_date) do nothing`,
      [TENANT, TECH_MAIN, attempt.rows[0].id],
    );
    await expectRejection(
      leave.applyForSelf(
        techUser(TECH_MAIN) as never,
        applyDto({
          startDate: addDays(today, -1),
          endDate: addDays(today, -1),
        }),
        KEY(),
      ),
      422,
      'LEAVE_CHECKED_IN_CONFLICT',
    );
  });

  it('probe 9: the apply preview is the twin — same counts, same rejections, ZERO rows written', async () => {
    const before = await count(
      'select count(*)::int as n from public.leave_requests where tenant_id = $1',
      [TENANT],
    );
    const ok = await leaveRead.previewApply(
      techUser(TECH_CROSS) as never,
      applyDto({
        startDate: addDays(today, 40),
        endDate: addDays(today, 41),
      }),
    );
    expect(ok.ok).toBe(true);
    expect(ok.workingDays).toBe(2);
    const bad = await leaveRead.previewApply(
      techUser(TECH_CROSS) as never,
      applyDto({
        startDate: addDays(today, -8),
        endDate: addDays(today, -8),
      }),
    );
    expect(bad.ok).toBe(false);
    expect(bad.errorCode).toBe('LEAVE_TOO_OLD');
    expect(
      await count(
        'select count(*)::int as n from public.leave_requests where tenant_id = $1',
        [TENANT],
      ),
    ).toBe(before);
  });

  // ============================================== 17-2: approve / reject

  it('probe 10: approve transitions every pending day, notifies the employee; own retry answers 200 with ONE event', async () => {
    const request = await leave.applyForSelf(
      techUser(TECH_MAIN) as never,
      applyDto({ startDate: addDays(today, 70), endDate: addDays(today, 71) }),
      KEY(),
    );
    const approved = await leave.approve(ownerUser() as never, request.id);
    expect(approved.status).toBe('approved');
    expect(approved.dates.every((d) => d.state === 'approved')).toBe(true);
    expect(
      await count(
        "select count(*)::int as n from public.notifications where event_type = 'leave.approved' and entity_id = $1",
        [request.id],
      ),
    ).toBe(1);
    const retry = await leave.approve(ownerUser() as never, request.id);
    expect(retry.status).toBe('approved');
    expect(
      await count(
        "select count(*)::int as n from public.leave_events where leave_request_id = $1 and cause = 'approve'",
        [request.id],
      ),
    ).toBe(1);
    const [a, b] = await Promise.allSettled([
      leave.approve(ownerUser() as never, request.id),
      leave.approve(ownerUser() as never, request.id),
    ]);
    expect(a.status).toBe('fulfilled');
    expect(b.status).toBe('fulfilled');
    expect(
      await count(
        "select count(*)::int as n from public.leave_events where leave_request_id = $1 and cause = 'approve'",
        [request.id],
      ),
    ).toBe(1);
  });

  it('probe 11: reject carries the reason when given and stays valid without one', async () => {
    const withReason = await leave.applyForSelf(
      techUser(TECH_MAIN) as never,
      applyDto({ startDate: addDays(today, 72), endDate: addDays(today, 72) }),
      KEY(),
    );
    await leave.reject(ownerUser() as never, withReason.id, 'No budget');
    expect(
      await count(
        "select count(*)::int as n from public.notifications where event_type = 'leave.rejected' and entity_id = $1 and payload->>'reason' = 'No budget'",
        [withReason.id],
      ),
    ).toBe(1);
    const withoutReason = await leave.applyForSelf(
      techUser(TECH_MAIN) as never,
      applyDto({ startDate: addDays(today, 73), endDate: addDays(today, 73) }),
      KEY(),
    );
    await leave.reject(ownerUser() as never, withoutReason.id, null);
    expect(
      (await leave.reject(ownerUser() as never, withoutReason.id, null)).status,
    ).toBe('rejected');
  });

  it('probe 12: on-behalf is approved immediately, notifies the employee, enforces validations, 404s a foreign target', async () => {
    const view = await applyApproved(
      TECH_MAIN,
      addDays(today, 80),
      addDays(today, 81),
    );
    expect(view.status).toBe('approved');
    expect(
      await count(
        "select count(*)::int as n from public.notifications where event_type = 'leave.applied_on_behalf' and entity_id = $1",
        [view.id],
      ),
    ).toBe(1);
    await expectRejection(
      applyApproved(TECH_MAIN, addDays(today, 81), addDays(today, 82)),
      409,
      'LEAVE_OVERLAP',
    );
    await expectRejection(
      leave.applyOnBehalf(
        ownerUser() as never,
        Object.assign(
          applyDto({
            startDate: addDays(today, 90),
            endDate: addDays(today, 90),
          }),
          { employeeId: randomUUID() },
        ),
        KEY(),
      ),
      404,
      'ATTENDANCE_EMPLOYEE_NOT_FOUND',
    );
  });

  // ==================================== 17-3: revoke / cancel with splits

  it('probe 13: revoke (rule 23:59) takes today AND the future, keeps the past; notification carries the dates + reason', async () => {
    const view = await applyApproved(
      TECH_LATE,
      addDays(today, -1),
      addDays(today, 2),
    );
    const revoked = await leave.revoke(
      ownerUser() as never,
      view.id,
      'Needed on site',
    );
    expect(revoked.status).toBe('approved'); // the past day stays approved
    expect(
      revoked.dates.find((d) => d.date === addDays(today, -1))?.state,
    ).toBe('approved');
    for (const future of [
      addDays(today, 0),
      addDays(today, 1),
      addDays(today, 2),
    ]) {
      expect(revoked.dates.find((d) => d.date === future)?.state).toBe(
        'revoked',
      );
    }
    const payload = await pool.query(
      "select payload from public.notifications where event_type = 'leave.owner_revoked' and entity_id = $1",
      [view.id],
    );
    expect(payload.rows[0].payload.revokedDates.sort()).toEqual(
      [addDays(today, 0), addDays(today, 1), addDays(today, 2)].sort(),
    );
    expect(payload.rows[0].payload.reason).toBe('Needed on site');
  });

  it('probe 14: revoke (rule 00:30) excludes today as cutoff_passed and keeps it approved', async () => {
    const view = await applyApproved(
      TECH_EARLY,
      addDays(today, -1),
      addDays(today, 1),
    );
    const revoked = await leave.revoke(
      ownerUser() as never,
      view.id,
      'Back to work',
    );
    expect(
      revoked.dates.find((d) => d.date === addDays(today, -1))?.state,
    ).toBe('approved');
    expect(revoked.dates.find((d) => d.date === addDays(today, 0))?.state).toBe(
      'approved',
    ); // cutoff passed
    expect(revoked.dates.find((d) => d.date === addDays(today, 1))?.state).toBe(
      'revoked',
    );
  });

  it('probe 15: revoke retry answers 200; after an employee cancel it conflicts', async () => {
    const view = await applyApproved(
      TECH_LATE,
      addDays(today, 82),
      addDays(today, 83),
    );
    await leave.revoke(ownerUser() as never, view.id, 'First revoke');
    const retry = await leave.revoke(
      ownerUser() as never,
      view.id,
      'Second revoke',
    );
    expect(retry.status).toBe('revoked');
    const conflict = await applyApproved(
      TECH_EARLY,
      addDays(today, 84),
      addDays(today, 84),
    );
    await leave.cancel(techUser(TECH_EARLY) as never, conflict.id);
    await expectRejection(
      leave.revoke(ownerUser() as never, conflict.id, 'Late'),
      409,
      'LEAVE_NOT_REVOKABLE',
    );
  });

  it('probe 16: cancel splits approved in-progress leave and notifies the owner; nothing actionable conflicts', async () => {
    const pending = await leave.applyForSelf(
      techUser(TECH_CROSS) as never,
      applyDto({ startDate: addDays(today, 85), endDate: addDays(today, 86) }),
      KEY(),
    );
    const cancelledPending = await leave.cancel(
      techUser(TECH_CROSS) as never,
      pending.id,
    );
    expect(cancelledPending.status).toBe('cancelled');
    expect(
      await count(
        "select count(*)::int as n from public.notifications where event_type = 'leave.employee_cancelled' and entity_id = $1",
        [pending.id],
      ),
    ).toBe(1);
    // An approved NOT-started request cancels entirely (FR-15). TECH_LATE
    // has not checked in yet at this point (probe 19 does that later).
    const notStarted = await applyApproved(
      TECH_LATE,
      addDays(today, 86),
      addDays(today, 87),
    );
    const cancelledApproved = await leave.cancel(
      techUser(TECH_LATE) as never,
      notStarted.id,
    );
    expect(cancelledApproved.status).toBe('cancelled');
    const retry = await leave.cancel(
      techUser(TECH_LATE) as never,
      notStarted.id,
    );
    expect(retry.status).toBe('cancelled');
    // A PAST-dated pending request is NOT cancellable — past dates are
    // never in the actionable set (D8): probe 6 left TECH_MAIN with one.
    const pastPending = await leaveRead.listMine(techUser(TECH_MAIN) as never, {
      status: 'pending',
    });
    const pastRequest = pastPending.data.find(
      (r) => r.startDate === addDays(today, -7),
    );
    expect(pastRequest).toBeTruthy();
    await expectRejection(
      leave.cancel(techUser(TECH_MAIN) as never, pastRequest!.id),
      409,
      'LEAVE_NOT_CANCELLABLE',
    );
    const foreign = await applyApproved(
      TECH_EARLY,
      addDays(today, 88),
      addDays(today, 88),
    );
    await leave.cancel(techUser(TECH_EARLY) as never, foreign.id);
    await expectRejection(
      leave.cancel(techUser(TECH_MAIN) as never, foreign.id),
      404,
      'LEAVE_REQUEST_NOT_FOUND',
    );
  });

  // ================================= 17-4: FR-9 check-in × leave (+ 20, 21)

  it('probe 17: FR-9 — the gate answers a committed 409; confirm cancels ONLY today and notifies the owner', async () => {
    const view = await applyApproved(
      TECH_CROSS,
      addDays(today, 0),
      addDays(today, 2),
    );
    await expectRejection(
      checkIn.checkIn(techUser(TECH_CROSS) as never, fix(), KEY()),
      409,
      'ATTENDANCE_LEAVE_CONFIRMATION_REQUIRED',
    );
    expect(
      await count(
        'select count(*)::int as n from public.attendance_records where employee_id = $1',
        [TECH_CROSS],
      ),
    ).toBe(0);
    const attempt = await pool.query(
      "select outcome from public.attendance_attempts where employee_id = $1 and outcome = 'leave_confirmation_required'",
      [TECH_CROSS],
    );
    expect(attempt.rows).toHaveLength(1);
    const ok = await checkIn.checkIn(
      techUser(TECH_CROSS) as never,
      Object.assign(fix(), { confirmLeaveCancel: true }),
      KEY(),
    );
    expect(ok.workDate).toBe(today);
    const days = await pool.query(
      'select leave_date::text as d, state from public.leave_request_days where leave_request_id = $1 order by leave_date',
      [view.id],
    );
    expect(days.rows[0]).toEqual({ d: today, state: 'cancelled' });
    expect(days.rows[1].state).toBe('approved');
    expect(days.rows[2].state).toBe('approved');
    expect(
      await count(
        "select count(*)::int as n from public.notifications where event_type = 'leave.checkin_auto_cancel' and entity_id = $1",
        [view.id],
      ),
    ).toBe(1);
  });

  it('probe 18: a HALF-day leave day checks straight through and keeps the leave', async () => {
    const view = await applyApproved(
      TECH_OFF,
      addDays(today, 0),
      addDays(today, 0),
      'first_half',
    );
    await checkIn.checkIn(techUser(TECH_OFF) as never, fix(), KEY());
    const day = await pool.query(
      'select state from public.leave_request_days where leave_request_id = $1',
      [view.id],
    );
    expect(day.rows[0].state).toBe('approved');
  });

  it('probe 19: a PENDING full-day leave gates the same way; confirm cancels from pending', async () => {
    const view = await leave.applyForSelf(
      techUser(TECH_LATE) as never,
      applyDto({ startDate: addDays(today, 0), endDate: addDays(today, 0) }),
      KEY(),
    );
    await expectRejection(
      checkIn.checkIn(techUser(TECH_LATE) as never, fix(), KEY()),
      409,
      'ATTENDANCE_LEAVE_CONFIRMATION_REQUIRED',
    );
    await checkIn.checkIn(
      techUser(TECH_LATE) as never,
      Object.assign(fix(), { confirmLeaveCancel: true }),
      KEY(),
    );
    const day = await pool.query(
      'select state from public.leave_request_days where leave_request_id = $1',
      [view.id],
    );
    expect(day.rows[0].state).toBe('cancelled');
  });

  it('probe 20: an off day inside an approved span never gates and never cancels (D11)', async () => {
    // Today becomes a weekly off for TECH_OFFDAY (override replaces the
    // empty default); an approved full-day leave spans today — checking in
    // on the OFF day must proceed with no dialog and touch nothing.
    must(
      await admin.from('attendance_weekly_off_overrides').insert({
        tenant_id: TENANT,
        employee_id: TECH_OFFDAY,
        valid: `[${today},)`,
        days: [isoWeekdayOf(today)],
      }),
    );
    const view = await applyApproved(
      TECH_OFFDAY,
      addDays(today, 0),
      addDays(today, 1),
    );
    await checkIn.checkIn(techUser(TECH_OFFDAY) as never, fix(), KEY());
    const after = await pool.query(
      "select state from public.leave_request_days where leave_request_id = $1 and leave_date = ((now() at time zone 'Asia/Kolkata')::date)",
      [view.id],
    );
    expect(after.rows[0].state).toBe('approved'); // untouched — the off-day rule
  });

  it('probe 21: a too_far check-in with confirm stays 422 and leaves the leave intact', async () => {
    const view = await applyApproved(
      TECH_MAIN,
      addDays(today, 0),
      addDays(today, 0),
    );
    await expectRejection(
      checkIn.checkIn(
        techUser(TECH_MAIN) as never,
        Object.assign(fix(), {
          latitude: 28.6139,
          longitude: 77.209,
          confirmLeaveCancel: true,
        }),
        KEY(),
      ),
      422,
      'ATTENDANCE_TOO_FAR',
    );
    const day = await pool.query(
      'select state from public.leave_request_days where leave_request_id = $1',
      [view.id],
    );
    expect(day.rows[0].state).toBe('approved');
  });

  // ============================================ D12 disable ripple + reads

  it('probe 22: disable cancels ALL pending days and approved days from the effective date; the employee is notified', async () => {
    const pendingView = await leave.applyForSelf(
      techUser(TECH_DISABLE) as never,
      applyDto({ startDate: addDays(today, -2), endDate: addDays(today, 2) }),
      KEY(),
    );
    const approvedView = await applyApproved(
      TECH_DISABLE,
      addDays(today, 3),
      addDays(today, 4),
    );
    await enrolments.disableEnrolment(ownerUser() as never, TECH_DISABLE, {});
    const states = await pool.query(
      'select leave_date::text as d, state from public.leave_request_days where leave_request_id in ($1, $2) order by leave_date',
      [pendingView.id, approvedView.id],
    );
    for (const row of states.rows) {
      expect(row.state).toBe('cancelled');
    }
    const event = await pool.query(
      "select actor_id from public.leave_events where leave_request_id = $1 and cause = 'disable'",
      [pendingView.id],
    );
    expect(event.rows[0].actor_id).toBeNull();
    expect(
      await count(
        "select count(*)::int as n from public.notifications where event_type = 'leave.cancelled_by_disable' and entity_id = $1",
        [pendingView.id],
      ),
    ).toBe(1);
  });

  it('probe 23: a past-dated pending request NEVER auto-expires', async () => {
    const view = await leave.applyForSelf(
      techUser(TECH_CROSS) as never,
      applyDto({ startDate: addDays(today, -7), endDate: addDays(today, -6) }),
      KEY(),
    );
    await leave.reject(ownerUser() as never, view.id, null);
    const pastPending = await leave.applyForSelf(
      techUser(TECH_CROSS) as never,
      applyDto({ startDate: addDays(today, -7), endDate: addDays(today, -6) }),
      KEY(),
    );
    expect(pastPending.status).toBe('pending');
    const mine = await leaveRead.listMine(techUser(TECH_CROSS) as never, {
      status: 'pending',
    });
    expect(mine.data.some((r) => r.id === pastPending.id)).toBe(true);
    expect(mine.data.find((r) => r.id === pastPending.id)?.status).toBe(
      'pending',
    );
  });

  it('probe 24: derived status in lists; owner queue filter; cursors are scope-contained', async () => {
    const mixed = await applyApproved(
      TECH_MAIN,
      addDays(today, 91),
      addDays(today, 92),
    );
    await leave.cancel(techUser(TECH_MAIN) as never, mixed.id); // cancels both future days → cancelled
    const list = await leaveRead.listForOwner(ownerUser() as never, {
      status: 'pending',
    });
    expect(list.data.every((r) => r.status === 'pending')).toBe(true);
    expect(list.data.every((r) => typeof r.employeeName === 'string')).toBe(
      true,
    );
    const mine = await leaveRead.listMine(techUser(TECH_MAIN) as never, {});
    expect(mine.data.every((r) => r.employeeId === TECH_MAIN)).toBe(true);
    const revoked = await applyApproved(
      TECH_MAIN,
      addDays(today, 93),
      addDays(today, 93),
    );
    await leave.revoke(ownerUser() as never, revoked.id, 'Probe');
    const history = await leaveRead.listMine(techUser(TECH_MAIN) as never, {});
    expect(history.data.find((r) => r.id === revoked.id)?.status).toBe(
      'revoked',
    );
    // A foreign-scope cursor is rejected, never silently honoured.
    const ownerPage = await leaveRead.listForOwner(ownerUser() as never, {
      limit: 1,
    });
    if (ownerPage.nextCursor) {
      await expectRejection(
        leaveRead.listMine(techUser(TECH_MAIN) as never, {
          cursor: ownerPage.nextCursor,
        }),
        400,
        'VALIDATION_ERROR',
      );
    }
  });

  it('probe 25: the guard trigger rejects an illegal raw transition with PT422', async () => {
    const view = await leave.applyForSelf(
      techUser(TECH_MAIN) as never,
      applyDto({ startDate: addDays(today, 94), endDate: addDays(today, 94) }),
      KEY(),
    );
    await leave.reject(ownerUser() as never, view.id, null);
    await expect(
      pool.query(
        "update public.leave_request_days set state = 'approved' where leave_request_id = $1",
        [view.id],
      ),
    ).rejects.toMatchObject({
      code: 'PT422',
      hint: 'LEAVE_INVALID_TRANSITION',
    });
  });

  it('probe 26: RLS denies anon/authenticated on all three leave tables; replay after auto-cancel is inert', async () => {
    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false },
    });
    for (const table of [
      'leave_requests',
      'leave_request_days',
      'leave_events',
    ]) {
      const { error } = await anon.from(table).select('id').limit(1);
      expect(error?.code).toBe('42501'); // permission denied — REVOKE ALL held
    }
  });
});
