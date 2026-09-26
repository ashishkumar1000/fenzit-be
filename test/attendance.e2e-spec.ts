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
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> | undefined }> = [];

  function qbFor(table: string) {
    const queue = tableQueues.get(table);
    if (!queue) throw new Error(`unexpected table ${table}`);
    const qb: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'is', 'order', 'in', 'update', 'maybeSingle', 'single']) {
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
            return Promise.resolve(queue.shift() ?? { data: null, error: null });
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
    return jwtService.sign({ sub: 'owner-uuid-e2e', tenantId: TENANT_ID, role: 'owner' });
  }

  function techJwt() {
    return jwtService.sign({ sub: 'tech-uuid-e2e', tenantId: TENANT_ID, role: 'technician' });
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
      tableQueues.set('attendance_settings', [{ data: settingsRow, error: null }]);
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
      queueRpc(
        'attendance_today',
        { data: '2026-09-26', error: null },
      );
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
      const createCall = rpcCalls.find((c) => c.name === 'attendance_create_office');
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
        error: { code: 'PT409', hint: 'ATTENDANCE_OFFICE_NAME_TAKEN', message: 'taken' },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/attendance/offices',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: OFFICE_PAYLOAD,
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).error_code).toBe('ATTENDANCE_OFFICE_NAME_TAKEN');
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
      const createCall = rpcCalls.find((c) => c.name === 'attendance_create_office');
      expect(createCall?.args).toMatchObject({ p_name: 'Andheri West' });

      const whitespaceOnly = await app.inject({
        method: 'POST',
        url: '/api/v1/attendance/offices',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { ...OFFICE_PAYLOAD, name: '   ' },
      });
      expect(whitespaceOnly.statusCode).toBe(422);
      expect(JSON.parse(whitespaceOnly.body).error_code).toBe('VALIDATION_ERROR');
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
      tableQueues.set('attendance_offices', [{ data: [officeRow], error: null }]);
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
      expect(JSON.parse(res.body).error_code).toBe('ATTENDANCE_OFFICE_NOT_FOUND');
    });

    it('POST /attendance/offices/:id/archive maps the unknown-office PT404 to a 404', async () => {
      queueRpc(
        'attendance_archive_office',
        {
          data: null,
          error: { code: 'PT404', hint: 'ATTENDANCE_OFFICE_NOT_FOUND', message: 'missing' },
        },
      );

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/attendance/offices/${OFFICE_ID}/archive`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error_code).toBe('ATTENDANCE_OFFICE_NOT_FOUND');
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
});
