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
 * HTTP boundary for the 19-2/19-3 read routes: GET /attendance/dashboard
 * (owner), GET /attendance/monthly (owner) and GET /attendance/me/monthly
 * (technician). Pins route mounting through AppModule, the ValidationPipe's
 * 422 (malformed officeId / calendar dates), the service range checks'
 * 422 ATTENDANCE_INVALID_RANGE, and the guards' 401/403 — with the DB
 * boundary mocked at SupabaseClientFactory (the AD-17 access gate) and the
 * direct pg pool, whose fake answers the batched statements the way the
 * real DB does (mirrored by the integration spec). Today is 2026-09-29.
 */

type RpcResult = { data: unknown; error: Record<string, unknown> | null };
type SqlResult = { rows: unknown[] };

const TENANT_ID = 'f2e0a5c7-1b9d-4c8e-a0f3-0000000000f0';
const EMPLOYEE_ID = 'f2e0a5c7-1b9d-4c8e-a0f3-0000000000f1';
const OFFICE_ID = 'f2e0a5c7-1b9d-4a5c-8b6d-0000000000f2';
const TENANT_TZ = 'Asia/Kolkata';
const TODAY = '2026-09-29';

const settingsGateRow = {
  enabled: true,
  setup_completed_at: '2026-09-01T00:00:00+00:00',
};
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
  full_day_hours: 8,
  half_day_hours: 4,
};
const presentRecordRow = {
  employee_id: EMPLOYEE_ID,
  work_date: '2026-09-28',
  checkin_at: '2026-09-28 09:25:00+05:30',
  checkout_at: '2026-09-28 18:40:00+05:30', // 555 worked min ≥ the 8h full-day setting (480)
};
const metaRow = {
  employee_id: EMPLOYEE_ID,
  employee_name: 'Asha',
  office_id: OFFICE_ID,
  office_name: 'Andheri West',
};
const accessViewRow = {
  user_id: EMPLOYEE_ID,
  tenant_id: TENANT_ID,
  attendance_enabled: true,
  access_state: 'active',
};

const FROM = '2026-09-01';
const TO = '2026-09-29'; // == tenant-today in the fixtures

describe('Dashboard + monthly read routes HTTP boundary (e2e, 19-2/19-3)', () => {
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
   * The fake tx answers the dashboard's and monthly's statements: one
   * tracked employee (one office + rule, a full present record on 09-28,
   * Sundays off — Sunday rides the tenant default, no override) for the
   * grid and flag reads, the roster's one meta row for the monthly read,
   * and EMPTY FLAG STRIPS + the weekly-off/holiday reads as the branch
   * order dictates. Branch order matters — several statements share
   * table names, so each read is keyed on its DISTINCTIVE token first.
   */
  function baseFacts(sql: string): SqlResult {
    if (sql.includes('attendance_today')) return { rows: [{ today: TODAY }] };
    // Flag (a) — the only statement spelling '' as attempt_count.
    if (sql.includes("'' as attempt_count")) return { rows: [] };
    // Flag (b) — f.attempt_count (the grid's attempt fact selects `as n`).
    if (sql.includes('f.attempt_count')) return { rows: [] };
    // 19-2's today candidate set (the tiles' tracked set).
    if (sql.includes('select distinct a.employee_id'))
      return { rows: [{ employee_id: EMPLOYEE_ID }] };
    // 19-3's roster metas (distinct on + the today-office left lateral).
    if (sql.includes('distinct on (e.employee_id)')) return { rows: [metaRow] };
    if (sql.includes('timezone from public.tenants'))
      return { rows: [{ timezone: TENANT_TZ }] };
    if (sql.includes('from public.attendance_settings'))
      return { rows: [settingsGateRow] };
    if (sql.includes('from public.attendance_enrolments'))
      return { rows: [enrolmentRow] };
    if (sql.includes('from public.attendance_office_assignments'))
      return { rows: [assignmentRow] };
    // The self view's weekly-offs ride the tenant DEFAULT (Sunday = 7):
    // the monthly reader's `@>` spellings are the monthly route's reads.
    if (sql.includes('valid @> $3::date')) return { rows: [] }; // override
    if (sql.includes('valid @> $2::date'))
      return { rows: [{ valid: '[2026-01-01,)', days: [7] }] }; // default
    if (sql.includes('from public.attendance_weekly_off_overrides'))
      return { rows: [] }; // the grid's range-wide overrides fact
    if (sql.includes('from public.attendance_weekly_off_defaults'))
      return { rows: [{ valid: '[2026-01-01,)', days: [7] }] };
    // The self view's upcoming holidays (>= today); the grid's holiday
    // facts ride the between spelling.
    if (sql.includes('holiday_date >= $2::date'))
      return {
        rows: [
          { holiday_date: '2026-10-02', holiday_name: 'Gandhi Jayanti' },
        ],
      };
    if (sql.includes('from public.holidays')) return { rows: [] };
    if (sql.includes('from public.attendance_office_rules'))
      return { rows: [ruleRow] };
    if (sql.includes('from public.attendance_records'))
      return { rows: [presentRecordRow] };
    if (sql.includes('from public.attendance_attempts')) return { rows: [] };
    if (sql.includes('from public.leave_request_days')) return { rows: [] };
    if (sql.includes('from public.attendance_day_overrides'))
      return { rows: [] };
    if (sql.includes('distinct on')) return { rows: [] }; // grid: newest audit entry per day
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

  describe('GET /attendance/dashboard (owner)', () => {
    it('200 — the pinned tile + flag key sets, one tracked not-checked-in employee', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/attendance/dashboard',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(Object.keys(body)).toEqual(['date', 'counts', 'flags']);
      expect(Object.keys(body.counts)).toEqual([
        'tracked',
        'checkedIn',
        'notCheckedIn',
        'late',
        'onLeave',
      ]);
      expect(Object.keys(body.flags)).toEqual([
        'checkoutMissing',
        'fakeLocationAttempt',
      ]);
      // Today: tracked, no check-in yet — the tile and the strips ride the
      // one engine grid + the two flag reads.
      expect(body.date).toBe(TODAY);
      expect(body.counts).toEqual({
        tracked: 1,
        checkedIn: 0,
        notCheckedIn: 1,
        late: 0,
        onLeave: 0,
      });
      expect(body.flags).toEqual({
        checkoutMissing: [],
        fakeLocationAttempt: [],
      });
    });

    it('422 VALIDATION_ERROR for a malformed officeId (DTO uuid rule)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/attendance/dashboard?officeId=not-a-uuid',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });
      expect(res.statusCode).toBe(422);
      expect(JSON.parse(res.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('403 on a technician JWT (owner surface)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/attendance/dashboard',
        headers: { authorization: `Bearer ${techJwt()}` },
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error_code).toBe('FORBIDDEN');
    });

    it('401 without a JWT', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/attendance/dashboard',
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /attendance/monthly (owner)', () => {
    it('200 — one roster employee with the nine-tile summary shape', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/attendance/monthly?from=${FROM}&to=${TO}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(Object.keys(body)).toEqual(['from', 'to', 'employees']);
      expect(body.from).toBe(FROM);
      expect(body.to).toBe(TO);
      expect(body.employees).toHaveLength(1);
      expect(Object.keys(body.employees[0])).toEqual([
        'employeeId',
        'employeeName',
        'officeId',
        'officeName',
        'summary',
      ]);
      expect(body.employees[0].employeeName).toBe('Asha');
      expect(Object.keys(body.employees[0].summary)).toEqual([
        'daysWorked',
        'halfDays',
        'lateCount',
        'leave',
        'weeklyOffs',
        'holidays',
        'workedOnHoliday',
        'absent',
        'checkoutMissing',
      ]);
      // The 09-28 record day earns a worked day; nothing else in the
      // range graded off the fixtures.
      expect(body.employees[0].summary.daysWorked).toBe(1);
    });

    it('422 ATTENDANCE_INVALID_RANGE when to is after tenant-today', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/attendance/monthly?from=' + `${FROM}&to=2026-09-30`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });
      expect(res.statusCode).toBe(422);
      expect(JSON.parse(res.body).error_code).toBe(
        'ATTENDANCE_INVALID_RANGE',
      );
    });

    it('422 ATTENDANCE_INVALID_RANGE for a 32-day span (cap 31)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/attendance/monthly?from=2026-09-01&to=2026-10-01',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });
      expect(res.statusCode).toBe(422);
      expect(JSON.parse(res.body).error_code).toBe(
        'ATTENDANCE_INVALID_RANGE',
      );
    });

    it('422 VALIDATION_ERROR for a non-existent calendar date (component round-trip)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/attendance/monthly?from=2026-02-31&to=' + `${TO}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });
      expect(res.statusCode).toBe(422);
      expect(JSON.parse(res.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('422 VALIDATION_ERROR for a malformed officeId (DTO uuid rule)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/attendance/monthly?from=${FROM}&to=${TO}&officeId=not-a-uuid`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });
      expect(res.statusCode).toBe(422);
      expect(JSON.parse(res.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('403 on a technician JWT (owner surface)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/attendance/monthly?from=${FROM}&to=${TO}`,
        headers: { authorization: `Bearer ${techJwt()}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('401 without a JWT', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/attendance/monthly?from=${FROM}&to=${TO}`,
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /attendance/me/monthly (technician)', () => {
    it('200 — identity from the JWT: summary + weeklyOffs + upcomingHolidays', async () => {
      tableQueues.set('attendance_access_state', [
        { data: accessViewRow, error: null },
      ]);

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/attendance/me/monthly?from=${FROM}&to=${TO}`,
        headers: { authorization: `Bearer ${techJwt()}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(Object.keys(body)).toEqual([
        'from',
        'to',
        'summary',
        'weeklyOffs',
        'upcomingHolidays',
      ]);
      // FR-11's structural parity: one aggregation function as the owner
      // route's summary — same keys, same credit steps.
      expect(Object.keys(body.summary)).toEqual([
        'daysWorked',
        'halfDays',
        'lateCount',
        'leave',
        'weeklyOffs',
        'holidays',
        'workedOnHoliday',
        'absent',
        'checkoutMissing',
      ]);
      expect(body.summary.daysWorked).toBe(1);
      // Today-effective pick: the Sunday tenant default (ISO 7).
      expect(body.weeklyOffs).toEqual([7]);
      expect(body.upcomingHolidays).toEqual([
        { holidayDate: '2026-10-02', holidayName: 'Gandhi Jayanti' },
      ]);
    });

    it('403 ATTENDANCE_NOT_TRACKED when the access gate says none', async () => {
      tableQueues.set('attendance_access_state', [
        { data: { ...accessViewRow, access_state: 'none' }, error: null },
      ]);

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/attendance/me/monthly?from=${FROM}&to=${TO}`,
        headers: { authorization: `Bearer ${techJwt()}` },
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error_code).toBe(
        'ATTENDANCE_NOT_TRACKED',
      );
    });

    it('422 ATTENDANCE_INVALID_RANGE when to is after tenant-today', async () => {
      tableQueues.set('attendance_access_state', [
        { data: accessViewRow, error: null },
      ]);

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/attendance/me/monthly?from=' + `${FROM}&to=2026-09-30`,
        headers: { authorization: `Bearer ${techJwt()}` },
      });
      expect(res.statusCode).toBe(422);
      expect(JSON.parse(res.body).error_code).toBe(
        'ATTENDANCE_INVALID_RANGE',
      );
    });

    it('403 on an owner JWT (technician surface)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/attendance/me/monthly?from=${FROM}&to=${TO}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('401 without a JWT', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/attendance/me/monthly?from=${FROM}&to=${TO}`,
      });
      expect(res.statusCode).toBe(401);
    });
  });
});
