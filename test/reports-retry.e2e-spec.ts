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

/**
 * Story 12-7 — POST /api/v1/reports/:id/retry (re-queue a FAILED report).
 *
 * The retry endpoint is owner-only and runs through the IdempotencyInterceptor
 * (a POST without an X-Idempotency-Key header passes straight through, per the
 * interceptor contract). The Supabase admin client is mocked so no live DB is
 * required: the retry path touches only `report_requests` — a tenant-scoped
 * fetch terminating in .single(), then the guarded UPDATE awaited directly.
 */
describe('Reports retry (e2e)', () => {
  let app: NestFastifyApplication;
  let jwtService: JwtService;
  let mockCreateAdmin: jest.Mock;

  const TENANT_ID = 'tenant-uuid-reports-retry-e2e';
  const OWNER_ID = '00000000-0000-4000-8000-000000000001';
  const TECH_ID = '00000000-0000-4000-8000-000000000002';
  const REQUEST_ID = '00000000-0000-4000-8000-0000000000a1';
  const RETRY_URL = `/api/v1/reports/${REQUEST_ID}/retry`;

  beforeAll(async () => {
    mockCreateAdmin = jest.fn();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SupabaseClientFactory)
      .useValue({ create: jest.fn(), createAdmin: mockCreateAdmin })
      .compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );

    app.setGlobalPrefix('api/v1', {
      exclude: ['health', 'internal/webhooks/storage'],
    });
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));

    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    jwtService = moduleFixture.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    mockCreateAdmin.mockReset();
  });

  function ownerJwt() {
    return jwtService.sign({ sub: OWNER_ID, tenantId: TENANT_ID, role: 'owner' });
  }

  function techJwt() {
    return jwtService.sign({
      sub: TECH_ID,
      tenantId: TENANT_ID,
      role: 'technician',
    });
  }

  const failedRow = {
    id: REQUEST_ID,
    tenant_id: TENANT_ID,
    requested_by: OWNER_ID,
    report_type: 'technician_job_activity',
    params: {
      start_date: '2026-09-01',
      end_date: '2026-09-07',
      technician_ids: [],
    },
    status: 'failed',
    attempt_count: 2,
    locked_until: null,
    r2_key: null,
    file_size_bytes: null,
    error_code: 'REPORT_GENERATION_FAILED',
    created_at: '2026-09-10T10:00:00Z',
    completed_at: '2026-09-10T10:05:00Z',
  };

  const requeuedRow = {
    ...failedRow,
    status: 'queued',
    error_code: null,
    completed_at: null,
    locked_until: null,
    attempt_count: 0,
  };

  /**
   * One chainable, self-thenable builder serving the whole retry path:
   * - the fetch chain ends in `.single()` → resolves `opts.row`
   * - the guarded UPDATE is awaited directly → `then` resolves `opts.update`
   * No X-Idempotency-Key is ever sent, so the interceptor passes through and
   * `idempotency_log` is never touched.
   */
  function mockReportAdmin(opts?: {
    row?: { data: unknown; error: unknown };
    update?: { data: unknown; error: unknown };
  }) {
    const captured: {
      eq: Array<[string, unknown]>;
      update: unknown[][];
      select: unknown[][];
    } = { eq: [], update: [], select: [] };

    const builder: Record<string, jest.Mock> & { then: jest.Mock } = {
      select: jest.fn((...args: unknown[]) => {
        captured.select.push(args);
        return builder;
      }),
      eq: jest.fn((...args: [string, unknown]) => {
        captured.eq.push(args);
        return builder;
      }),
      update: jest.fn((...args: unknown[]) => {
        captured.update.push(args);
        return builder;
      }),
      single: jest.fn(() =>
        Promise.resolve(
          opts?.row ?? { data: failedRow, error: null },
        ),
      ),
    } as never;
    builder.then = jest.fn((resolve: (v: unknown) => unknown) =>
      resolve(opts?.update ?? { data: [requeuedRow], error: null }),
    );

    const from = jest.fn((table: string) => {
      if (table !== 'report_requests') {
        throw new Error(`unexpected table ${table}`);
      }
      return builder;
    });
    mockCreateAdmin.mockReturnValue({ from });
    return { from, builder, captured };
  }

  describe('201 — happy path', () => {
    it('re-queues a failed report and returns the camelCase envelope', async () => {
      const { captured } = mockReportAdmin();

      const response = await app.inject({
        method: 'POST',
        url: RETRY_URL,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(201);
      expect(JSON.parse(response.body)).toEqual({
        id: REQUEST_ID,
        status: 'queued',
        createdAt: '2026-09-10T10:00:00Z',
      });
      // The guarded UPDATE: reset stamp + attempt budget, guarded on the
      // row still being failed (the double-tap race guard).
      expect(captured.update[0][0]).toEqual({
        status: 'queued',
        error_code: null,
        completed_at: null,
        locked_until: null,
        attempt_count: 0,
      });
      expect(captured.eq).toContainEqual(['id', REQUEST_ID]);
      expect(captured.eq).toContainEqual(['status', 'failed']);
    });
  });

  describe('403 / 401 — auth', () => {
    it('should return 403 for a technician JWT (owner-only route)', async () => {
      const from = jest.fn();
      mockCreateAdmin.mockReturnValue({ from });

      const response = await app.inject({
        method: 'POST',
        url: RETRY_URL,
        headers: { authorization: `Bearer ${techJwt()}` },
      });

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body).error_code).toBe('FORBIDDEN');
      expect(from).not.toHaveBeenCalled();
    });

    it('should return 401 with no JWT', async () => {
      const from = jest.fn();
      mockCreateAdmin.mockReturnValue({ from });

      const response = await app.inject({
        method: 'POST',
        url: RETRY_URL,
        headers: {},
      });

      expect(response.statusCode).toBe(401);
      expect(JSON.parse(response.body).error_code).toBe('UNAUTHORIZED');
      expect(from).not.toHaveBeenCalled();
    });
  });

  describe('400 — malformed id', () => {
    it('should 400 VALIDATION_ERROR on a non-UUID :id (ParseUUIDPipe)', async () => {
      const from = jest.fn();
      mockCreateAdmin.mockReturnValue({ from });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/reports/not-a-uuid/retry',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error_code).toBe('VALIDATION_ERROR');
      expect(from).not.toHaveBeenCalled();
    });
  });

  describe('404 — unknown or cross-tenant row', () => {
    it("should 404 RESOURCE_NOT_FOUND when the row is not the caller tenant's", async () => {
      mockReportAdmin({
        row: {
          data: null,
          error: { code: 'PGRST116', message: 'JSON object requested' },
        },
      });

      const response = await app.inject({
        method: 'POST',
        url: RETRY_URL,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.body).error_code).toBe('RESOURCE_NOT_FOUND');
    });
  });

  describe('409 — not retryable', () => {
    it('should 409 REPORT_NOT_RETRYABLE for a ready row (nothing to retry)', async () => {
      const { from, captured } = mockReportAdmin({
        row: { data: { ...failedRow, status: 'ready' }, error: null },
      });

      const response = await app.inject({
        method: 'POST',
        url: RETRY_URL,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(409);
      expect(JSON.parse(response.body).error_code).toBe(
        'REPORT_NOT_RETRYABLE',
      );
      // The UPDATE chain was never issued — only the fetch's createAdmin call.
      expect(from).toHaveBeenCalledTimes(1);
      expect(captured.update).toHaveLength(0);
    });

    it('should 409 REPORT_NOT_RETRYABLE when the guarded update matched no row (race lost)', async () => {
      mockReportAdmin({ update: { data: [], error: null } });

      const response = await app.inject({
        method: 'POST',
        url: RETRY_URL,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(409);
      expect(JSON.parse(response.body).error_code).toBe(
        'REPORT_NOT_RETRYABLE',
      );
    });
  });

  describe('429 — in-flight cap', () => {
    it('should map the PT429 guard-trigger error to 429 REPORT_IN_FLIGHT_LIMIT', async () => {
      mockReportAdmin({
        update: {
          data: null,
          error: { code: 'PT429', message: 'in-flight cap reached' },
        },
      });

      const response = await app.inject({
        method: 'POST',
        url: RETRY_URL,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(429);
      expect(JSON.parse(response.body).error_code).toBe(
        'REPORT_IN_FLIGHT_LIMIT',
      );
    });
  });
});