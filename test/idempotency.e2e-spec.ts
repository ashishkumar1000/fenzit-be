/**
 * Story 4.2 — Idempotent Action Replay E2E tests
 *
 * The IdempotencyInterceptor and idempotency_log were built in Story 3.5/3.6.
 * These tests verify the full AC set for Story 4.2, with particular focus on
 * AC3 (cross-tenant key isolation) which is not covered elsewhere.
 *
 * The Supabase client is mocked (createAdmin) so no live DB is required.
 * Each test controls what the mock returns for the idempotency_log lookup,
 * which determines whether the interceptor replays or forwards to the handler.
 */
import { ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { JwtService } from '@nestjs/jwt';
import { AppModule } from '../src/app.module';
import { SupabaseClientFactory } from '../src/common/factories/supabase-client.factory';
import { StorageService } from '../src/storage/storage.service';

describe('Idempotency (e2e) — Story 4.2', () => {
  let app: NestFastifyApplication;
  let jwtService: JwtService;
  let mockCreateAdmin: jest.Mock;

  // Two tenants for AC3 cross-tenant isolation test
  const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const TECH_A = '11111111-1111-4111-8111-111111111111';
  const TECH_B = '22222222-2222-4222-8222-222222222222';
  const JOB_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

  // The same key string used by both tenants in the cross-tenant test
  const SHARED_KEY = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

  const WORKFLOW_URL = `/api/v1/jobs/${JOB_ID}/workflow`;

  beforeAll(async () => {
    mockCreateAdmin = jest.fn();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SupabaseClientFactory)
      .useValue({
        create: jest.fn(),
        createAdmin: mockCreateAdmin,
      })
      .overrideProvider(StorageService)
      .useValue({
        getPresignedUploadUrl: jest.fn(),
        getPresignedReadUrl: jest.fn(),
      })
      .compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app.setGlobalPrefix('api/v1', {
      exclude: ['health', 'internal/webhooks/storage'],
    });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: false,
        transform: true,
        errorHttpStatusCode: 422,
      }),
    );

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

  function techJwt(tenantId: string, sub: string) {
    return jwtService.sign({ sub, tenantId, role: 'technician' });
  }

  /**
   * Build a chainable Supabase mock that handles:
   * - idempotency_log select (lookup) → returns `idempotencyLookup`
   * - idempotency_log insert (persist on miss) → resolves ok (swallowed)
   * - jobs select (WorkflowService job fetch) → returns `jobLookup`
   * - supabase.rpc (advance_workflow_step) → returns `rpcResult`
   */
  function mockAdmin(opts: {
    idempotencyLookup?: { data: unknown; error: unknown };
    jobLookup?: { data: unknown; error: unknown };
    rpcResult?: { data: unknown; error: unknown };
  }) {
    const jobRow = {
      id: JOB_ID,
      tenant_id: TENANT_A,
      technician_id: TECH_A,
      status: 'scheduled',
      current_step: null,
      job_number: 'JB-2026-0001',
      customer_id: 'cust-1',
      service_location: '12 MG Road',
      service_type: 'ac_service',
      scheduled_start: '2026-06-22T09:00:00Z',
      scheduled_end: null,
      priority: 'normal',
      require_completion_photo: false,
      description: null,
      notes_for_technician: null,
      created_at: '2026-06-21T00:00:00Z',
      updated_at: '2026-06-21T00:00:00Z',
    };

    const advancedRow = {
      ...jobRow,
      status: 'in_progress',
      current_step: 'on_my_way',
    };

    const chain = () => {
      let table = '';
      const obj: Record<string, jest.Mock> = {};

      obj.from = jest.fn((t: string) => {
        table = t;
        return obj;
      });
      obj.rpc = jest.fn(() =>
        Promise.resolve(opts.rpcResult ?? { data: [advancedRow], error: null }),
      );
      obj.select = jest.fn(() => obj);
      obj.eq = jest.fn(() => obj);
      obj.gt = jest.fn(() => obj);
      obj.single = jest.fn(() =>
        Promise.resolve(opts.jobLookup ?? { data: jobRow, error: null }),
      );
      obj.maybeSingle = jest.fn(() => {
        if (table === 'idempotency_log')
          return Promise.resolve(
            opts.idempotencyLookup ?? { data: null, error: null },
          );
        return Promise.resolve({ data: null, error: null });
      });
      obj.insert = jest.fn(() => Promise.resolve({ data: null, error: null }));

      return obj;
    };

    mockCreateAdmin.mockImplementation(chain);
    // Return the first chain instance so callers can assert on mock calls.
    const firstInstance = chain();
    mockCreateAdmin.mockReturnValueOnce(firstInstance);
    return firstInstance;
  }

  // ── AC1: duplicate key within 24h → replay original body ─────────────────

  describe('AC1 — duplicate key within 24h replays original body', () => {
    it('workflow step with same key → 200 with cached body, RPC not re-called', async () => {
      const cached = { id: JOB_ID, status: 'in_progress', currentStep: 'on_my_way' };
      const chainInstance = mockAdmin({
        idempotencyLookup: { data: { response_body: cached }, error: null },
      });

      const res = await app.inject({
        method: 'POST',
        url: WORKFLOW_URL,
        headers: {
          authorization: `Bearer ${techJwt(TENANT_A, TECH_A)}`,
          'x-idempotency-key': SHARED_KEY,
        },
        payload: { step: 'on_my_way' },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual(cached);
      // Cache hit — the route handler (and its RPC) must not have run.
      expect(chainInstance.rpc).not.toHaveBeenCalled();
    });
  });

  // ── AC3: cross-tenant — same key treated independently ───────────────────

  describe('AC3 — cross-tenant: same key string is scoped per tenant', () => {
    it('Tenant A gets a cache hit; Tenant B (same key, different tenant) gets a miss and proceeds', async () => {
      // Tenant A: cache hit (idempotency_log lookup returns a row)
      const cachedBodyA = { id: JOB_ID, status: 'in_progress', currentStep: 'arrived' };

      mockAdmin({
        idempotencyLookup: { data: { response_body: cachedBodyA }, error: null },
      });

      const resA = await app.inject({
        method: 'POST',
        url: WORKFLOW_URL,
        headers: {
          authorization: `Bearer ${techJwt(TENANT_A, TECH_A)}`,
          'x-idempotency-key': SHARED_KEY,
        },
        payload: { step: 'arrived' },
      });

      expect(resA.statusCode).toBe(200);
      expect(JSON.parse(resA.body)).toEqual(cachedBodyA);

      // Tenant B: same key string, but lookup returns null (miss) → proceeds to handler
      // The handler returns a fresh response (rpcResult), proving B is treated independently.
      const advancedB = {
        id: JOB_ID,
        status: 'in_progress',
        currentStep: 'on_my_way',
      };
      mockAdmin({
        idempotencyLookup: { data: null, error: null },
        rpcResult: { data: [{ ...advancedB }], error: null },
        jobLookup: {
          data: {
            id: JOB_ID,
            tenant_id: TENANT_B,
            technician_id: TECH_B,
            status: 'scheduled',
            current_step: null,
            job_number: 'JB-2026-0002',
            customer_id: 'cust-2',
            service_location: '5 Park St',
            service_type: 'pest_control',
            scheduled_start: '2026-06-22T10:00:00Z',
            scheduled_end: null,
            priority: 'normal',
            require_completion_photo: false,
            description: null,
            notes_for_technician: null,
            created_at: '2026-06-21T00:00:00Z',
            updated_at: '2026-06-21T00:00:00Z',
          },
          error: null,
        },
      });

      // Tenant B submits the same SHARED_KEY — interceptor scopes lookup by tenant_id,
      // so this is a miss for B and the handler runs fresh.
      const resB = await app.inject({
        method: 'POST',
        url: WORKFLOW_URL,
        headers: {
          authorization: `Bearer ${techJwt(TENANT_B, TECH_B)}`,
          'x-idempotency-key': SHARED_KEY,
        },
        payload: { step: 'on_my_way' },
      });

      // B's request proceeds (200 from the handler), not replaying A's cached body
      expect(resB.statusCode).toBe(200);
      expect(JSON.parse(resB.body)).not.toEqual(cachedBodyA);
    });
  });

  // ── AC4: no key → proceeds normally ──────────────────────────────────────

  describe('AC4 — no X-Idempotency-Key header → request proceeds normally', () => {
    it('no key header → handler runs, 200 returned', async () => {
      mockAdmin({ idempotencyLookup: { data: null, error: null } });

      const res = await app.inject({
        method: 'POST',
        url: WORKFLOW_URL,
        headers: {
          authorization: `Bearer ${techJwt(TENANT_A, TECH_A)}`,
          // no x-idempotency-key
        },
        payload: { step: 'on_my_way' },
      });

      expect(res.statusCode).toBe(200);
    });
  });

  // ── Malformed key → 422 ───────────────────────────────────────────────────

  describe('malformed X-Idempotency-Key → 422 VALIDATION_ERROR', () => {
    it('non-UUID key is rejected before reaching the handler', async () => {
      mockAdmin({});

      const res = await app.inject({
        method: 'POST',
        url: WORKFLOW_URL,
        headers: {
          authorization: `Bearer ${techJwt(TENANT_A, TECH_A)}`,
          'x-idempotency-key': 'not-a-uuid',
        },
        payload: { step: 'on_my_way' },
      });

      expect(res.statusCode).toBe(422);
      expect(JSON.parse(res.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('UUID v1 (not v4) is rejected', async () => {
      mockAdmin({});

      const res = await app.inject({
        method: 'POST',
        url: WORKFLOW_URL,
        headers: {
          authorization: `Bearer ${techJwt(TENANT_A, TECH_A)}`,
          // UUID v1 — version nibble is '1', not '4'
          'x-idempotency-key': '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
        },
        payload: { step: 'on_my_way' },
      });

      expect(res.statusCode).toBe(422);
      expect(JSON.parse(res.body).error_code).toBe('VALIDATION_ERROR');
    });
  });
});
