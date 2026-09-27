import { INestApplication, ValidationPipe } from '@nestjs/common';
import { VALIDATION_PIPE_OPTIONS } from '../src/common/validation-pipe-options';
import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { JwtService } from '@nestjs/jwt';
import { AppModule } from '../src/app.module';
import { SupabaseClientFactory } from '../src/common/factories/supabase-client.factory';

/**
 * HTTP boundary for the attendance module (Epic 15): stories 15-2 (setup
 * wizard) and 15-3 (offices). Pins what the unit specs cannot see — route
 * mounting through AppModule, the ValidationPipe's 422, the guards' 401/403
 * — with the DB boundary mocked at SupabaseClientFactory (unit specs cover
 * the service/RPC mapping; the real-DB probes live in the integration suite).
 */

type RpcResult = { data: unknown; error: Record<string, unknown> | null };

const TENANT_ID = 'f2e0a5c7-1b9d-4c8e-a0f3-0000000000e2';
const OFFICE_ID = 'f2e0a5c7-1b9d-4a5c-8b6d-0000000000e3';

const settingsRow = {
  tenant_id: TENANT_ID,
  enabled: false,
  setup_completed_at: null,
  created_at: '2026-09-26T00:00:00Z',
  updated_at: '2026-09-26T00:00:00Z',
};
const progressRow = {
  tenant_id: TENANT_ID,
  current_step: 'offices',
  created_at: '2026-09-26T00:00:00Z',
  updated_at: '2026-09-26T00:00:00Z',
};
const officeRow = {
  id: OFFICE_ID,
  tenant_id: TENANT_ID,
  name: 'Andheri West',
  latitude: 19.1364,
  longitude: 72.8296,
  radius_m: 100,
  archived_at: null,
  created_at: '2026-09-26T00:00:00Z',
  updated_at: '2026-09-26T00:00:00Z',
};
const ruleRow = {
  id: 'rule-uuid-e2e',
  office_id: OFFICE_ID,
  tenant_id: TENANT_ID,
  valid: '[2026-09-26,)',
  start_time: '10:00:00',
  end_time: '18:00:00',
  late_cutoff_minutes: 15,
  full_day_hours: '8.00',
  half_day_hours: '4.00',
  created_at: '2026-09-26T00:00:00Z',
  updated_at: '2026-09-26T00:00:00Z',
};

const OFFICE_PAYLOAD = {
  name: 'Andheri West',
  latitude: 19.1364,
  longitude: 72.8296,
  radiusM: 100,
  startTime: '10:00',
  endTime: '18:00',
  lateCutoffMinutes: 15,
  fullDayHours: 8,
  halfDayHours: 4,
};

describe('Attendance HTTP boundary (e2e, stories 15-2/15-3)', () => {
  let app: NestFastifyApplication;
  let jwtService: JwtService;

  // One admin mock for the whole run: a flex query builder per table (result
  // queue, consumed once per awaited chain) and per-name RPC queues. Tests
  // queue exactly what they assert on; unqueued table reads throw (drift
  // guard), an empty RPC queue resolves null success.
  const tableQueues = new Map<string, RpcResult[]>();
  const rpcQueues = new Map<string, RpcResult[]>();
  const rpcCalls: Array<{
    name: string;
    args: Record<string, unknown> | undefined;
  }> = [];

  function qbFor(table: string) {
    const queue = tableQueues.get(table);
    if (!queue) throw new Error(`unexpected table ${table}`);
    const qb: Record<string, unknown> = {};
    for (const m of [
      'select',
      'eq',
      'is',
      'order',
      'in',
      'update',
      'maybeSingle',
      'single',
    ]) {
      qb[m] = jest.fn().mockReturnValue(qb);
    }
    (qb as unknown as { then: unknown }).then = jest.fn(
      (resolve: (v: RpcResult) => unknown) =>
        Promise.resolve(resolve(queue.shift() ?? { data: null, error: null })),
    );
    return qb;
  }

  function queueRpc(name: string, ...results: RpcResult[]) {
    rpcQueues.set(name, results);
  }

  function resetQueues() {
    tableQueues.clear();
    rpcQueues.clear();
    rpcCalls.length = 0;
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
          rpc: jest.fn((name: string, args?: Record<string, unknown>) => {
            const queue = rpcQueues.get(name);
            if (!queue) throw new Error(`unexpected rpc ${name}`);
            rpcCalls.push({ name, args });
            return Promise.resolve(
              queue.shift() ?? { data: null, error: null },
            );
          }),
        })),
      })
      .compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );

    // Mirror main.ts: health rides the prefix since a60fb30 (2026-09-21).
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
      sub: 'tech-uuid-e2e',
      tenantId: TENANT_ID,
      role: 'technician',
    });
  }

  describe('setup wizard routes (15-2 defer: mounting, 403, 422)', () => {
    it('GET /attendance/setup is mounted and reports an unstarted wizard', async () => {
      tableQueues.set('attendance_settings', [
        { data: null, error: null },
        { data: null, error: null },
      ]);
      tableQueues.set('attendance_setup_progress', [
        { data: null, error: null },
      ]);

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/attendance/setup',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        started: false,
        currentStep: null,
        setupCompletedAt: null,
        enabled: false,
      });
    });

    it('PATCH /attendance/setup moves the step marker (guarded update)', async () => {
      tableQueues.set('attendance_settings', [
        { data: settingsRow, error: null },
      ]);
      tableQueues.set('attendance_setup_progress', [
        { data: [TENANT_ID], error: null },
      ]);

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/attendance/setup',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { currentStep: 'timings' },
      });

      expect(res.statusCode).toBe(200);
    });

    it('PATCH /attendance/setup rejects an unknown step with 422 (ValidationPipe)', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/attendance/setup',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { currentStep: 'not-a-step' },
      });

      expect(res.statusCode).toBe(422);
      expect(JSON.parse(res.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('technician JWT is 403 on setup routes', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/attendance/setup',
        headers: { authorization: `Bearer ${techJwt()}` },
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error_code).toBe('FORBIDDEN');
    });

    it('missing JWT is 401', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/attendance/setup',
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('office routes (story 15-3)', () => {
    it('POST /attendance/offices creates through the RPC and returns 201 with the seeded rule', async () => {
      queueRpc('attendance_today', { data: '2026-09-26', error: null });
      queueRpc('attendance_create_office', { data: OFFICE_ID, error: null });
      tableQueues.set('attendance_offices', [{ data: officeRow, error: null }]);
      tableQueues.set('attendance_office_rules', [
        { data: [ruleRow], error: null },
      ]);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/attendance/offices',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: OFFICE_PAYLOAD,
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({
        id: OFFICE_ID,
        name: 'Andheri West',
        radiusM: 100,
        rule: { startTime: '10:00', validFrom: '2026-09-26', validTo: null },
        nextRule: null,
      });
    });

    it('POST /attendance/offices seeds the defaults for omitted optional fields', async () => {
      queueRpc('attendance_today', { data: '2026-09-26', error: null });
      queueRpc('attendance_create_office', { data: OFFICE_ID, error: null });
      tableQueues.set('attendance_offices', [{ data: officeRow, error: null }]);
      tableQueues.set('attendance_office_rules', [
        { data: [ruleRow], error: null },
      ]);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/attendance/offices',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: {
          name: 'Andheri West',
          latitude: 19.1364,
          longitude: 72.8296,
          startTime: '10:00',
          endTime: '18:00',
        },
      });

      expect(res.statusCode).toBe(201);
      const createCall = rpcCalls.find(
        (c) => c.name === 'attendance_create_office',
      );
      expect(createCall?.args).toMatchObject({
        p_radius_m: 100,
        p_late_cutoff_minutes: 15,
        p_full_day_hours: 8,
        p_half_day_hours: 4,
      });
    });

    it('POST /attendance/offices maps the duplicate-name PT409 to a 409', async () => {
      queueRpc('attendance_today', { data: '2026-09-26', error: null });
      queueRpc('attendance_create_office', {
        data: null,
        error: {
          code: 'PT409',
          hint: 'ATTENDANCE_OFFICE_NAME_TAKEN',
          message: 'taken',
        },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/attendance/offices',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: OFFICE_PAYLOAD,
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).error_code).toBe(
        'ATTENDANCE_OFFICE_NAME_TAKEN',
      );
    });

    it('POST /attendance/offices trims the name and rejects a whitespace-only one', async () => {
      queueRpc('attendance_today', { data: '2026-09-26', error: null });
      queueRpc('attendance_create_office', { data: OFFICE_ID, error: null });
      tableQueues.set('attendance_offices', [{ data: officeRow, error: null }]);
      tableQueues.set('attendance_office_rules', [
        { data: [ruleRow], error: null },
      ]);

      const trimmed = await app.inject({
        method: 'POST',
        url: '/api/v1/attendance/offices',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { ...OFFICE_PAYLOAD, name: '  Andheri West  ' },
      });
      expect(trimmed.statusCode).toBe(201);
      const createCall = rpcCalls.find(
        (c) => c.name === 'attendance_create_office',
      );
      expect(createCall?.args).toMatchObject({ p_name: 'Andheri West' });

      const whitespaceOnly = await app.inject({
        method: 'POST',
        url: '/api/v1/attendance/offices',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { ...OFFICE_PAYLOAD, name: '   ' },
      });
      expect(whitespaceOnly.statusCode).toBe(422);
      expect(JSON.parse(whitespaceOnly.body).error_code).toBe(
        'VALIDATION_ERROR',
      );
    });

    it('POST /attendance/offices rejects half-day hours ≥ full-day hours with 422', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/attendance/offices',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { ...OFFICE_PAYLOAD, fullDayHours: 4, halfDayHours: 8 },
      });

      expect(res.statusCode).toBe(422);
      expect(JSON.parse(res.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('POST /attendance/offices rejects an endTime before startTime with 422', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/attendance/offices',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { ...OFFICE_PAYLOAD, startTime: '09:00', endTime: '08:00' },
      });

      expect(res.statusCode).toBe(422);
      expect(JSON.parse(res.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('GET /attendance/offices/:id rejects a malformed uuid with 400', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/attendance/offices/not-a-uuid',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('POST /attendance/offices rejects an out-of-range radius with 422', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/attendance/offices',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { ...OFFICE_PAYLOAD, radiusM: 40 },
      });

      expect(res.statusCode).toBe(422);
      expect(JSON.parse(res.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('POST /attendance/offices rejects a non-HH:mm startTime with 422', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/attendance/offices',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { ...OFFICE_PAYLOAD, startTime: '25:00' },
      });

      expect(res.statusCode).toBe(422);
    });

    it('GET /attendance/offices lists offices with the rule covering today', async () => {
      queueRpc('attendance_today', { data: '2026-09-26', error: null });
      tableQueues.set('attendance_offices', [
        { data: [officeRow], error: null },
      ]);
      tableQueues.set('attendance_office_rules', [
        { data: [ruleRow], error: null },
      ]);

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/attendance/offices',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toHaveLength(1);
      expect(JSON.parse(res.body)[0]).toMatchObject({
        id: OFFICE_ID,
        rule: { validFrom: '2026-09-26' },
      });
    });

    it('GET /attendance/offices rejects an includeArchived value outside true/false with 422', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/attendance/offices?includeArchived=1',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(res.statusCode).toBe(422);
      expect(JSON.parse(res.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('PATCH /attendance/offices/:id rejects a partial rules set with 400', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/attendance/offices/${OFFICE_ID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { startTime: '08:00' },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toContain('complete set');
    });

    it('PATCH /attendance/offices/:id routes a complete rules set to the RPC', async () => {
      queueRpc('attendance_update_office_rules', { data: null, error: null });
      tableQueues.set('attendance_offices', [
        { data: officeRow, error: null }, // re-read after the RPC
      ]);
      tableQueues.set('attendance_office_rules', [
        { data: [ruleRow], error: null },
      ]);

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/attendance/offices/${OFFICE_ID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: {
          startTime: '09:00',
          endTime: '17:00',
          lateCutoffMinutes: 20,
          fullDayHours: 8,
          halfDayHours: 4,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).rules).toHaveLength(1);
    });

    it('GET /attendance/offices/:id is 404 for an unknown (or foreign) office', async () => {
      tableQueues.set('attendance_offices', []);

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/attendance/offices/${OFFICE_ID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error_code).toBe(
        'ATTENDANCE_OFFICE_NOT_FOUND',
      );
    });

    it('POST /attendance/offices/:id/archive maps the unknown-office PT404 to a 404', async () => {
      queueRpc('attendance_archive_office', {
        data: null,
        error: {
          code: 'PT404',
          hint: 'ATTENDANCE_OFFICE_NOT_FOUND',
          message: 'missing',
        },
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/attendance/offices/${OFFICE_ID}/archive`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error_code).toBe(
        'ATTENDANCE_OFFICE_NOT_FOUND',
      );
    });

    it('POST /attendance/offices/:id/archive is 204 when the RPC succeeds', async () => {
      queueRpc('attendance_archive_office', { data: null, error: null });

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/attendance/offices/${OFFICE_ID}/archive`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(res.statusCode).toBe(204);
      expect(res.body).toBe('');
    });

    it('technician JWT is 403 on office routes', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/attendance/offices',
        headers: { authorization: `Bearer ${techJwt()}` },
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error_code).toBe('FORBIDDEN');
    });
  });

  describe('weekly-off routes (story 15-5)', () => {
    const EMPLOYEE_ID = 'f2e0a5c7-1b9d-4c8e-a0f3-0000000000e5';
    const defaultRow = {
      id: 'wo-e2e-1',
      tenant_id: TENANT_ID,
      valid: '[2026-09-20,)',
      days: [6, 7],
      created_at: '2026-09-20T00:00:00Z',
      updated_at: '2026-09-20T00:00:00Z',
    };
    const overrideRow = {
      id: 'wo-e2e-o1',
      tenant_id: TENANT_ID,
      employee_id: EMPLOYEE_ID,
      valid: '[2026-09-25,)',
      days: [5],
      created_at: '2026-09-25T00:00:00Z',
      updated_at: '2026-09-25T00:00:00Z',
    };
    const employeeUser = {
      id: EMPLOYEE_ID,
      name: 'Ravi Kumar',
      country_code: '+91',
      phone_number: '9999900005',
    };

    it('weekly-off routes reject a no-tenant owner JWT with 400 VALIDATION_ERROR', async () => {
      const noTenantJwt = jwtService.sign({
        sub: 'owner-uuid-e2e',
        tenantId: null,
        role: 'owner',
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/attendance/weekly-offs',
        headers: { authorization: `Bearer ${noTenantJwt}` },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error_code).toBe('VALIDATION_ERROR');
      // The guard passes the null tenant through — requireTenant (service
      // layer) is what produces the 400, not a 401/403 from the boundary.
      expect(rpcCalls).toHaveLength(0);
    });

    it('GET /attendance/weekly-offs is mounted and reports the empty default state (no rows is a 200, not a 404)', async () => {
      queueRpc('attendance_today', { data: '2026-09-26', error: null });
      tableQueues.set('attendance_weekly_off_defaults', []);

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/attendance/weekly-offs',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        default: null,
        next: null,
        history: [],
      });
    });

    it('PUT /attendance/weekly-offs sets the default through the RPC and returns the resolved default', async () => {
      queueRpc('attendance_set_weekly_off_default', {
        data: null,
        error: null,
      });
      queueRpc('attendance_today', { data: '2026-09-26', error: null });
      tableQueues.set('attendance_weekly_off_defaults', [
        { data: [defaultRow], error: null },
      ]);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/v1/attendance/weekly-offs',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { days: [6, 7] },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).default).toEqual({
        days: [6, 7],
        validFrom: '2026-09-20',
        validTo: null,
      });
      const call = rpcCalls.find(
        (c) => c.name === 'attendance_set_weekly_off_default',
      );
      expect(call?.args).toEqual({
        p_tenant_id: TENANT_ID,
        p_days: [6, 7],
        p_effective_from: null,
      });
    });

    it('PUT /attendance/weekly-offs passes a past effectiveFrom through (the RPC clamps, AD-8)', async () => {
      queueRpc('attendance_set_weekly_off_default', {
        data: null,
        error: null,
      });
      queueRpc('attendance_today', { data: '2026-09-26', error: null });
      tableQueues.set('attendance_weekly_off_defaults', []);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/v1/attendance/weekly-offs',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { days: [7], effectiveFrom: '2026-01-01' },
      });

      expect(res.statusCode).toBe(200);
      const call = rpcCalls.find(
        (c) => c.name === 'attendance_set_weekly_off_default',
      );
      expect(call?.args).toMatchObject({ p_effective_from: '2026-01-01' });
    });

    it('PUT /attendance/weekly-offs rejects all seven days with 422 ATTENDANCE_NO_WORKING_DAYS before any DB call', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/v1/attendance/weekly-offs',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { days: [1, 2, 3, 4, 5, 6, 7] },
      });

      expect(res.statusCode).toBe(422);
      expect(JSON.parse(res.body).error_code).toBe(
        'ATTENDANCE_NO_WORKING_DAYS',
      );
      // The drift-guard mock throws on an unexpected rpc — reaching here at
      // all proves the pre-DB guard short-circuited.
      expect(rpcCalls).toHaveLength(0);
    });

    it('PUT /attendance/weekly-offs accepts an empty days array (the explicit clear)', async () => {
      queueRpc('attendance_set_weekly_off_default', {
        data: null,
        error: null,
      });
      queueRpc('attendance_today', { data: '2026-09-26', error: null });
      tableQueues.set('attendance_weekly_off_defaults', []);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/v1/attendance/weekly-offs',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { days: [] },
      });

      expect(res.statusCode).toBe(200);
      const call = rpcCalls.find(
        (c) => c.name === 'attendance_set_weekly_off_default',
      );
      expect(call?.args).toMatchObject({ p_days: [] });
    });

    it.each([
      ['an out-of-vocabulary day', { days: [0] }],
      ['a duplicate day', { days: [6, 6] }],
      [
        'an impossible effectiveFrom',
        { days: [6], effectiveFrom: '2026-02-30' },
      ],
      ['a non-integer day', { days: ['monday'] }],
    ])(
      'PUT /attendance/weekly-offs rejects %s with 422 (ValidationPipe)',
      async (_label, payload) => {
        const res = await app.inject({
          method: 'PUT',
          url: '/api/v1/attendance/weekly-offs',
          headers: { authorization: `Bearer ${ownerJwt()}` },
          payload: payload as Record<string, unknown>,
        });

        expect(res.statusCode).toBe(422);
        expect(JSON.parse(res.body).error_code).toBe('VALIDATION_ERROR');
        expect(rpcCalls).toHaveLength(0);
      },
    );

    it('GET /attendance/weekly-offs/overrides lists per-employee overrides with names, sorted by name', async () => {
      const EMP_B = 'f2e0a5c7-1b9d-4c8e-a0f3-0000000000eb';
      queueRpc('attendance_today', { data: '2026-09-26', error: null });
      tableQueues.set('attendance_weekly_off_overrides', [
        {
          data: [
            overrideRow,
            {
              ...overrideRow,
              employee_id: EMP_B,
              valid: '[2026-10-05,)',
              days: [1],
            },
          ],
          error: null,
        },
      ]);
      tableQueues.set('users', [
        {
          data: [
            employeeUser,
            {
              id: EMP_B,
              name: 'Alpha Singh',
              country_code: '+91',
              phone_number: '9999900006',
            },
          ],
          error: null,
        },
      ]);

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/attendance/weekly-offs/overrides',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.map((r: { employeeName: string }) => r.employeeName)).toEqual(
        ['Alpha Singh', 'Ravi Kumar'],
      );
      expect(body[1].current).toEqual({
        days: [5],
        validFrom: '2026-09-25',
        validTo: null,
      });
    });

    it('PUT /attendance/weekly-offs/overrides/:employeeId sets through the RPC and returns the detail', async () => {
      queueRpc('attendance_set_weekly_off_override', {
        data: null,
        error: null,
      });
      queueRpc('attendance_today', { data: '2026-09-26', error: null });
      tableQueues.set('attendance_weekly_off_overrides', [
        { data: [overrideRow], error: null },
      ]);
      tableQueues.set('users', [{ data: [employeeUser], error: null }]);

      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/attendance/weekly-offs/overrides/${EMPLOYEE_ID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { days: [5] },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        employeeId: EMPLOYEE_ID,
        employeeName: 'Ravi Kumar',
        current: { days: [5], validFrom: '2026-09-25', validTo: null },
        next: null,
      });
      const call = rpcCalls.find(
        (c) => c.name === 'attendance_set_weekly_off_override',
      );
      expect(call?.args).toMatchObject({
        p_employee_id: EMPLOYEE_ID,
        p_days: [5],
        p_effective_from: null,
      });
    });

    it('PUT override rejects all seven days with 422 ATTENDANCE_NO_WORKING_DAYS pre-DB', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/attendance/weekly-offs/overrides/${EMPLOYEE_ID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { days: [1, 2, 3, 4, 5, 6, 7] },
      });

      expect(res.statusCode).toBe(422);
      expect(JSON.parse(res.body).error_code).toBe(
        'ATTENDANCE_NO_WORKING_DAYS',
      );
      expect(rpcCalls).toHaveLength(0);
    });

    it('PUT override maps the non-member PT404 to 404 ATTENDANCE_EMPLOYEE_NOT_FOUND', async () => {
      queueRpc('attendance_set_weekly_off_override', {
        data: null,
        error: {
          code: 'PT404',
          hint: 'ATTENDANCE_EMPLOYEE_NOT_FOUND',
          message: 'not member',
        },
      });

      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/attendance/weekly-offs/overrides/${EMPLOYEE_ID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { days: [5] },
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error_code).toBe(
        'ATTENDANCE_EMPLOYEE_NOT_FOUND',
      );
    });

    it('PUT override rejects a malformed :employeeId with 400 before any DB call', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/v1/attendance/weekly-offs/overrides/not-a-uuid',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { days: [5] },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error_code).toBe('VALIDATION_ERROR');
      expect(rpcCalls).toHaveLength(0);
    });

    it('DELETE /attendance/weekly-offs/overrides/:employeeId removes and returns the post-removal state', async () => {
      queueRpc('attendance_remove_weekly_off_override', {
        data: null,
        error: null,
      });
      queueRpc('attendance_today', { data: '2026-09-26', error: null });
      tableQueues.set('attendance_weekly_off_overrides', []);
      tableQueues.set('users', [{ data: [employeeUser], error: null }]);

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/attendance/weekly-offs/overrides/${EMPLOYEE_ID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        employeeId: EMPLOYEE_ID,
        employeeName: 'Ravi Kumar',
        current: null,
        next: null,
      });
    });

    it('technician JWT is 403 on weekly-off routes', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/attendance/weekly-offs',
        headers: { authorization: `Bearer ${techJwt()}` },
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error_code).toBe('FORBIDDEN');
    });
  });

  describe('holiday routes (story 15-5)', () => {
    const HOLIDAY_ID = 'f2e0a5c7-1b9d-4c8e-a0f3-0000000000e6';
    const holidayRow = {
      id: HOLIDAY_ID,
      tenant_id: TENANT_ID,
      holiday_date: '2026-10-02',
      name: 'Gandhi Jayanti',
      created_at: '2026-09-26T00:00:00Z',
      updated_at: '2026-09-26T00:00:00Z',
    };

    it('GET /attendance/holidays is mounted and returns [] when none exist', async () => {
      queueRpc('attendance_today', { data: '2026-09-26', error: null });
      tableQueues.set('holidays', []);

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/attendance/holidays',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual([]);
    });

    it('POST /attendance/holidays adds through the RPC and returns 201 { id, date, name }', async () => {
      queueRpc('attendance_add_holiday', { data: HOLIDAY_ID, error: null });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/attendance/holidays',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { date: '2026-10-02', name: 'Gandhi Jayanti' },
      });

      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.body)).toEqual({
        id: HOLIDAY_ID,
        date: '2026-10-02',
        name: 'Gandhi Jayanti',
      });
      const call = rpcCalls.find((c) => c.name === 'attendance_add_holiday');
      expect(call?.args).toEqual({
        p_tenant_id: TENANT_ID,
        p_holiday_date: '2026-10-02',
        p_name: 'Gandhi Jayanti',
      });
    });

    it('POST /attendance/holidays allows a past date (statuses recompute on read)', async () => {
      queueRpc('attendance_add_holiday', { data: HOLIDAY_ID, error: null });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/attendance/holidays',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { date: '2026-01-26', name: 'Republic Day' },
      });

      expect(res.statusCode).toBe(201);
    });

    it('POST /attendance/holidays maps the duplicate-date PT409 to 409 ATTENDANCE_HOLIDAY_TAKEN', async () => {
      queueRpc('attendance_add_holiday', {
        data: null,
        error: {
          code: 'PT409',
          hint: 'ATTENDANCE_HOLIDAY_TAKEN',
          message: 'taken',
        },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/attendance/holidays',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { date: '2026-10-02', name: 'Gandhi Jayanti' },
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).error_code).toBe('ATTENDANCE_HOLIDAY_TAKEN');
    });

    it.each([
      ['an impossible date', { date: '2026-02-30', name: 'Not a day' }],
      ['a non-ISO date', { date: '02/10/2026', name: 'Slashed' }],
      ['a whitespace-only name', { date: '2026-10-02', name: '   ' }],
      ['a missing name', { date: '2026-10-02' }],
    ])(
      'POST /attendance/holidays rejects %s with 422 (ValidationPipe)',
      async (_label, payload) => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/attendance/holidays',
          headers: { authorization: `Bearer ${ownerJwt()}` },
          payload: payload as Record<string, unknown>,
        });

        expect(res.statusCode).toBe(422);
        expect(JSON.parse(res.body).error_code).toBe('VALIDATION_ERROR');
        expect(rpcCalls).toHaveLength(0);
      },
    );

    it('PATCH /attendance/holidays/:id renames through the RPC and returns the re-read row', async () => {
      queueRpc('attendance_update_holiday', { data: null, error: null });
      tableQueues.set('holidays', [
        { data: { ...holidayRow, name: 'Diwali' }, error: null },
      ]);

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/attendance/holidays/${HOLIDAY_ID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { name: 'Diwali' },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        id: HOLIDAY_ID,
        date: '2026-10-02',
        name: 'Diwali',
      });
      const call = rpcCalls.find((c) => c.name === 'attendance_update_holiday');
      expect(call?.args).toMatchObject({
        p_holiday_id: HOLIDAY_ID,
        p_name: 'Diwali',
      });
    });

    it('PATCH /attendance/holidays/:id with a `date` key (and nothing else) is 422 from the ValidationPipe', async () => {
      // The global pipe strips the unknown `date` key first (whitelist,
      // forbidNonWhitelisted: false); with no name left to validate it fails
      // on the name rule — 422 VALIDATION_ERROR before the controller runs.
      // This exercises the PIPE path; the raw-body guard has its own test
      // below (a `date` key alongside a valid `name` is the only payload
      // that reaches it through the pipe).
      const patchRes = await app.inject({
        method: 'PATCH',
        url: `/api/v1/attendance/holidays/${HOLIDAY_ID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { date: '2030-01-01' },
      });

      expect(patchRes.statusCode).toBe(422);
      expect(JSON.parse(patchRes.body).error_code).toBe('VALIDATION_ERROR');
      expect(rpcCalls).toHaveLength(0);

      // The rejected patch mutated nothing — the holiday keeps its date.
      queueRpc('attendance_today', { data: '2026-09-26', error: null });
      tableQueues.set('holidays', [{ data: [holidayRow], error: null }]);
      const getRes = await app.inject({
        method: 'GET',
        url: '/api/v1/attendance/holidays',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });
      expect(getRes.statusCode).toBe(200);
      expect(JSON.parse(getRes.body)[0]).toEqual({
        id: HOLIDAY_ID,
        date: '2026-10-02',
        name: 'Gandhi Jayanti',
      });
    });

    it('PATCH /attendance/holidays/:id with both `date` and `name` is 422 from the raw-body date guard', async () => {
      // The only payload shape that reaches rejectDateKey through the pipe:
      // `name` satisfies the DTO, so validation passes — then the raw-body
      // check rejects the `date` key with its own message (a date change is
      // remove + add; the date is immutable).
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/attendance/holidays/${HOLIDAY_ID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { date: '2030-01-01', name: 'Diwali' },
      });

      expect(res.statusCode).toBe(422);
      const body = JSON.parse(res.body);
      expect(body.error_code).toBe('VALIDATION_ERROR');
      expect(body.message).toBe(
        'A holiday date cannot be changed — remove the holiday and add it on the new date',
      );
      expect(rpcCalls).toHaveLength(0);
    });

    it('PATCH /attendance/holidays/:id rejects a malformed id with 400 and an unknown id with 404', async () => {
      const malformed = await app.inject({
        method: 'PATCH',
        url: '/api/v1/attendance/holidays/not-a-uuid',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { name: 'X' },
      });
      expect(malformed.statusCode).toBe(400);
      expect(JSON.parse(malformed.body).error_code).toBe('VALIDATION_ERROR');

      queueRpc('attendance_update_holiday', {
        data: null,
        error: {
          code: 'PT404',
          hint: 'ATTENDANCE_HOLIDAY_NOT_FOUND',
          message: 'missing',
        },
      });
      const unknown = await app.inject({
        method: 'PATCH',
        url: `/api/v1/attendance/holidays/${HOLIDAY_ID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { name: 'X' },
      });
      expect(unknown.statusCode).toBe(404);
      expect(JSON.parse(unknown.body).error_code).toBe(
        'ATTENDANCE_HOLIDAY_NOT_FOUND',
      );
    });

    it('DELETE /attendance/holidays/:id removes through the RPC (204)', async () => {
      queueRpc('attendance_remove_holiday', { data: null, error: null });

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/attendance/holidays/${HOLIDAY_ID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(res.statusCode).toBe(204);
      expect(res.body).toBe('');
      const call = rpcCalls.find((c) => c.name === 'attendance_remove_holiday');
      expect(call?.args).toMatchObject({ p_holiday_id: HOLIDAY_ID });
    });

    it('DELETE /attendance/holidays/:id rejects a malformed id with 400 and an unknown id with 404', async () => {
      const malformed = await app.inject({
        method: 'DELETE',
        url: '/api/v1/attendance/holidays/not-a-uuid',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });
      expect(malformed.statusCode).toBe(400);

      queueRpc('attendance_remove_holiday', {
        data: null,
        error: {
          code: 'PT404',
          hint: 'ATTENDANCE_HOLIDAY_NOT_FOUND',
          message: 'missing',
        },
      });
      const unknown = await app.inject({
        method: 'DELETE',
        url: `/api/v1/attendance/holidays/${HOLIDAY_ID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });
      expect(unknown.statusCode).toBe(404);
      expect(JSON.parse(unknown.body).error_code).toBe(
        'ATTENDANCE_HOLIDAY_NOT_FOUND',
      );
    });

    it('GET /attendance/holidays/impact returns the empty preview pre-15-7', async () => {
      queueRpc('attendance_holiday_impact', { data: [], error: null });

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/attendance/holidays/impact?date=2026-10-02',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        date: '2026-10-02',
        affectedEmployees: [],
      });
      const call = rpcCalls.find((c) => c.name === 'attendance_holiday_impact');
      expect(call?.args).toEqual({
        p_tenant_id: TENANT_ID,
        p_date: '2026-10-02',
      });
    });

    it('GET /attendance/holidays/impact maps preview rows to camelCase', async () => {
      queueRpc('attendance_holiday_impact', {
        data: [{ employee_id: 'emp-1', employee_name: 'Ravi Kumar' }],
        error: null,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/attendance/holidays/impact?date=2026-10-02',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).affectedEmployees).toEqual([
        { employeeId: 'emp-1', employeeName: 'Ravi Kumar' },
      ]);
    });

    it('GET /attendance/holidays/impact rejects an impossible date with 422', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/attendance/holidays/impact?date=2026-13-01',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(res.statusCode).toBe(422);
      expect(JSON.parse(res.body).error_code).toBe('VALIDATION_ERROR');
      expect(rpcCalls).toHaveLength(0);
    });

    it('technician JWT is 403 on holiday routes', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/attendance/holidays',
        headers: { authorization: `Bearer ${techJwt()}` },
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error_code).toBe('FORBIDDEN');
    });
  });
});
