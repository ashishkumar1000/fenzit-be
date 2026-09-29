import { ValidationPipe } from '@nestjs/common';
import { VALIDATION_PIPE_OPTIONS } from '../src/common/validation-pipe-options';
import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { JwtService } from '@nestjs/jwt';
import { AppModule } from '../src/app.module';
import { SupabaseClientFactory } from '../src/common/factories/supabase-client.factory';
import { PgPoolFactory } from '../src/common/pg/pg-pool.factory';

/**
 * HTTP boundary for the 18-1 day-statuses reads: GET /attendance/day-statuses
 * (owner) and GET /attendance/me/day-statuses (technician). Pins route
 * mounting through AppModule, the ValidationPipe's 422, the guards'
 * 401/403, and the wire row shape (DayStatusRow over the FR-10 engine) —
 * the DB boundary is mocked at SupabaseClientFactory (access-state gate)
 * and the direct pg pool, whose fake answers the batched grid statements
 * the way the real DB does (mirrored by the integration spec).
 */

type RpcResult = { data: unknown; error: Record<string, unknown> | null };
type SqlResult = { rows: unknown[] };

const TENANT_ID = 'f2e0a5c7-1b9d-4c8e-a0f3-0000000000f0';
const EMPLOYEE_ID = 'f2e0a5c7-1b9d-4c8e-a0f3-0000000000f1';
const OFFICE_ID = 'f2e0a5c7-1b9d-4a5c-8b6d-0000000000f2';
const TODAY = '2026-09-29'; // Tuesday

const settingsGateRow = { enabled: true, setup_completed_at: '2026-09-01T00:00:00+00:00' };
const enrolmentRow = {
  employee_id: EMPLOYEE_ID,
  valid: '[2026-09-01,)',
  enabled_at: '2026-09-15T04:00:00+00:00',
};
const assignmentRow = {
  employee_id: EMPLOYEE_ID,
  office_id: OFFICE_ID,
  valid: '[2026-09-01,)',
  office_name: 'Andheri West',
  office_lat: 19.1364,
  office_lng: 72.8296,
  radius_m: 100,
};
const ruleRow = {
  id: 'rule-uuid-e2e',
  office_id: OFFICE_ID,
  valid: '[2026-01-01,)',
  start_time: '09:30:00',
  end_time: '18:30:00',
  late_cutoff_minutes: 15,
  // G2-D1: the hours columns are the grading thresholds (window minutes only
  // drive the late/early metrics).
  full_day_hours: 8,
  half_day_hours: 4,
};
const presentRecordRow = {
  employee_id: EMPLOYEE_ID,
  work_date: '2026-09-28',
  checkin_at: '2026-09-28 09:25:00+05:30',
  checkout_at: '2026-09-28 18:40:00+05:30', // 555 worked min ≥ the 8h full-day setting (480)
};

const accessViewRow = {
  user_id: EMPLOYEE_ID,
  tenant_id: TENANT_ID,
  attendance_enabled: true,
  access_state: 'active',
};

// Monday..Sunday of the walkthrough week — 09-28 (a corrected-present
// record day) through 10-04 (the Sunday weekly off), today 09-29 inside.
const FROM = '2026-09-28';
const TO = '2026-10-04';

describe('Day-statuses HTTP boundary (e2e, 18-1)', () => {
  let app: NestFastifyApplication;
  let jwtService: JwtService;

  const tableQueues = new Map<string, RpcResult[]>();
  let txFacts: ((sql: string) => SqlResult) | null = null;

  function qbFor(table: string) {
    const queue = tableQueues.get(table);
    if (!queue) throw new Error(`unexpected table ${table}`);
    const qb: Record<string, unknown> = {};
    for (const m of [
      'select', 'eq', 'is', 'order', 'in', 'update', 'upsert', 'maybeSingle', 'single',
    ]) {
      qb[m] = jest.fn().mockReturnValue(qb);
    }
    (qb as unknown as { then: unknown }).then = jest.fn(
      (resolve: (v: RpcResult) => unknown) =>
        Promise.resolve(resolve(queue.shift() ?? { data: null, error: null })),
    );
    return qb;
  }

  function resetQueues() {
    tableQueues.clear();
    txFacts = null;
  }

  /**
   * The fake tx answers the readDayStatusGrid statements in order — the
   * same shape the live probe verified against the real DB (one employee,
   * one office + rule, a full present record on 09-28, Sunday off).
   */
  function baseFacts(sql: string): SqlResult {
    if (sql.includes('attendance_today')) return { rows: [{ today: TODAY }] };
    if (sql.includes('from public.tenants where')) return { rows: [{ timezone: 'Asia/Kolkata' }] };
    if (sql.includes('from public.attendance_settings')) return { rows: [settingsGateRow] };
    if (sql.includes('from public.attendance_enrolments')) return { rows: [enrolmentRow] };
    if (sql.includes('from public.attendance_office_assignments')) return { rows: [assignmentRow] };
    if (sql.includes('from public.attendance_weekly_off_overrides')) return { rows: [] };
    if (sql.includes('from public.attendance_weekly_off_defaults'))
      return { rows: [{ valid: '[2026-01-01,)', days: [7] }] };
    if (sql.includes('from public.holidays')) return { rows: [] };
    if (sql.includes('from public.attendance_office_rules')) return { rows: [ruleRow] };
    if (sql.includes('from public.attendance_records')) return { rows: [presentRecordRow] };
    if (sql.includes('from public.attendance_attempts')) return { rows: [] };
    if (sql.includes('from public.leave_request_days')) return { rows: [] };
    if (sql.includes('from public.attendance_day_overrides')) return { rows: [] };
    if (sql.includes('distinct on')) return { rows: [] }; // grid: newest audit entry per day
    if (sql.startsWith('select count(*)::text as n from public.users'))
      return { rows: [{ n: '1' }] };
    return { rows: [] };
  }

  function pgTxOverride() {
    return {
      withTransaction: (work: (client: unknown) => Promise<unknown>) =>
        work({
          // The real pg client's query() IS a promise — chainable via .then —
          // so the fake must resolve, not return a bare result object.
          query: (sql: string) => Promise.resolve((txFacts ?? baseFacts)(sql)),
        }),
      onModuleDestroy: async () => undefined,
    };
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SupabaseClientFactory)
      .useValue({
        create: jest.fn(),
        createAdmin: jest.fn().mockImplementation(() => ({
          from: jest.fn((table: string) => qbFor(table)),
          rpc: jest.fn(() => Promise.resolve({ data: null, error: null })),
        })),
      })
      .overrideProvider(PgPoolFactory)
      .useValue(pgTxOverride())
      .compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app.setGlobalPrefix('api/v1', { exclude: ['internal/webhooks/storage'] });
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    jwtService = moduleFixture.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(resetQueues);

  function ownerJwt() {
    return jwtService.sign({
      sub: 'owner-uuid-e2e',
      tenantId: TENANT_ID,
      role: 'owner',
    });
  }

  function techJwt() {
    return jwtService.sign({
      sub: EMPLOYEE_ID,
      tenantId: TENANT_ID,
      role: 'technician',
    });
  }

  describe('GET /attendance/day-statuses (owner)', () => {
    it('200 — every date of the range, oldest first, with the FR-10 wire fields', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/attendance/day-statuses?employeeId=${EMPLOYEE_ID}&from=${FROM}&to=${TO}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.employeeId).toBe(EMPLOYEE_ID);
      expect(body.from).toBe(FROM);
      expect(body.to).toBe(TO);
      expect(body.days).toHaveLength(7);
      expect(body.days.map((d: { workDate: string }) => d.workDate)).toEqual([
        '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
      ]);
      // The record day: present, full-day credit, AD-7 tenant-offset instants.
      expect(body.days[0]).toMatchObject({
        workDate: FROM,
        status: 'present',
        daysWorked: 1,
        leaveCredit: 0,
        workedMinutes: 555,
        isLate: false,
        checkinAt: '2026-09-28T09:25:00+05:30',
        checkinSource: 'gps',
        markers: [],
      });
      // The Sunday weekly off, and today still not checked in.
      const sunday = body.days[6];
      expect(sunday).toMatchObject({
        workDate: TO,
        status: 'weekly_off',
        isWeeklyOff: true,
        daysWorked: 0,
      });
      expect(body.days[1]).toMatchObject({
        workDate: '2026-09-29',
        status: 'not_checked_in_yet',
      });
    });

    it('422 ATTENDANCE_INVALID_RANGE for a reversed range', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/attendance/day-statuses?employeeId=${EMPLOYEE_ID}&from=${TO}&to=${FROM}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });
      expect(res.statusCode).toBe(422);
      expect(JSON.parse(res.body).error_code).toBe('ATTENDANCE_INVALID_RANGE');
    });

    it('422 ATTENDANCE_INVALID_RANGE for a 63-day span (cap 62, before any per-date work)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/attendance/day-statuses?employeeId=' +
          `${EMPLOYEE_ID}&from=2026-08-01&to=2026-10-02`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });
      expect(res.statusCode).toBe(422);
      expect(JSON.parse(res.body).error_code).toBe('ATTENDANCE_INVALID_RANGE');
    });

    it('200 on the exact 62-day boundary and on a single day (from == to) (G2-P12)', async () => {
      // 2026-09-01 → 2026-11-01 is exactly 62 days; one past the cap is 422.
      const exact = await app.inject({
        method: 'GET',
        url: '/api/v1/attendance/day-statuses?employeeId=' +
          `${EMPLOYEE_ID}&from=2026-09-01&to=2026-11-01`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });
      expect(exact.statusCode).toBe(200);
      expect(JSON.parse(exact.body).days).toHaveLength(62);

      const single = await app.inject({
        method: 'GET',
        url: `/api/v1/attendance/day-statuses?employeeId=${EMPLOYEE_ID}&from=${FROM}&to=${FROM}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });
      expect(single.statusCode).toBe(200);
      expect(JSON.parse(single.body).days).toHaveLength(1);
    });

    it('422 for a malformed employeeId (DTO uuid rule, ValidationPipe)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/attendance/day-statuses?employeeId=not-a-uuid&from=${FROM}&to=${FROM}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });
      expect(res.statusCode).toBe(422);
      expect(JSON.parse(res.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('404 ATTENDANCE_EMPLOYEE_NOT_FOUND for an unknown (or foreign) employee', async () => {
      txFacts = (sql) =>
        sql.startsWith('select count(*)::text as n from public.users')
          ? { rows: [{ n: '0' }] }
          : baseFacts(sql);

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/attendance/day-statuses?employeeId=${EMPLOYEE_ID}&from=${FROM}&to=${FROM}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error_code).toBe(
        'ATTENDANCE_EMPLOYEE_NOT_FOUND',
      );
    });

    it('403 on a technician JWT (owner surface)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/attendance/day-statuses?employeeId=${EMPLOYEE_ID}&from=${FROM}&to=${FROM}`,
        headers: { authorization: `Bearer ${techJwt()}` },
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error_code).toBe('FORBIDDEN');
    });

    it('401 without a JWT', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/attendance/day-statuses?employeeId=${EMPLOYEE_ID}&from=${FROM}&to=${FROM}`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('400 VALIDATION_ERROR on a no-tenant JWT (requireTenant at the service layer)', async () => {
      const noTenantJwt = jwtService.sign({
        sub: 'owner-uuid-e2e',
        tenantId: null,
        role: 'owner',
      });
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/attendance/day-statuses?employeeId=${EMPLOYEE_ID}&from=${FROM}&to=${FROM}`,
        headers: { authorization: `Bearer ${noTenantJwt}` },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error_code).toBe('VALIDATION_ERROR');
    });
  });

  describe('GET /attendance/me/day-statuses (technician)', () => {
    it('200 — own range read, identity from the JWT (no employeeId key)', async () => {
      tableQueues.set('attendance_access_state', [{ data: accessViewRow, error: null }]);

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/attendance/me/day-statuses?from=${FROM}&to=${TO}`,
        headers: { authorization: `Bearer ${techJwt()}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(Object.keys(body)).toEqual(['from', 'to', 'days']);
      expect(body.days[0]).toMatchObject({
        workDate: FROM,
        status: 'present',
        daysWorked: 1,
      });
    });

    it('403 ATTENDANCE_NOT_TRACKED when the access gate says none', async () => {
      tableQueues.set('attendance_access_state', [
        { data: { ...accessViewRow, access_state: 'none' }, error: null },
      ]);

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/attendance/me/day-statuses?from=${FROM}&to=${TO}`,
        headers: { authorization: `Bearer ${techJwt()}` },
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error_code).toBe('ATTENDANCE_NOT_TRACKED');
    });

    it('403 on an owner JWT (technician surface; the gate never reads)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/attendance/me/day-statuses?from=${FROM}&to=${TO}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('422 ATTENDANCE_INVALID_RANGE for a reversed range and 200 at the exact 62-day cap (G2-P12)', async () => {
      tableQueues.set('attendance_access_state', [{ data: accessViewRow, error: null }]);

      const reversed = await app.inject({
        method: 'GET',
        url: `/api/v1/attendance/me/day-statuses?from=${TO}&to=${FROM}`,
        headers: { authorization: `Bearer ${techJwt()}` },
      });
      expect(reversed.statusCode).toBe(422);
      expect(JSON.parse(reversed.body).error_code).toBe('ATTENDANCE_INVALID_RANGE');

      const exact = await app.inject({
        method: 'GET',
        url: '/api/v1/attendance/me/day-statuses?from=2026-09-01&to=2026-11-01',
        headers: { authorization: `Bearer ${techJwt()}` },
      });
      expect(exact.statusCode).toBe(200);
      expect(JSON.parse(exact.body).days).toHaveLength(62);
    });

    it('422 for an impossible from date (AttendanceCalendarDateConstraint)', async () => {
      tableQueues.set('attendance_access_state', [{ data: accessViewRow, error: null }]);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/attendance/me/day-statuses?from=2026-02-30&to=2026-02-30',
        headers: { authorization: `Bearer ${techJwt()}` },
      });
      expect(res.statusCode).toBe(422);
      expect(JSON.parse(res.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('401 without a JWT', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/attendance/me/day-statuses?from=${FROM}&to=${TO}`,
      });
      expect(res.statusCode).toBe(401);
    });
  });
});
