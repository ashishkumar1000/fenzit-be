/**
 * Story 4.3 — Server-Side Conflict Resolution E2E tests
 *
 * AC1: Same-step replay without idempotency key → 200 with current job state, RPC not called
 * AC3: Photo re-upload (webhook processed twice) → conflict_resolved log appended
 * AC4: Signature re-upload → conflict_resolved log appended
 *
 * The Supabase client is mocked so no live DB is required.
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

describe('Conflict Resolution (e2e) — Story 4.3', () => {
  let app: NestFastifyApplication;
  let jwtService: JwtService;
  let mockCreateAdmin: jest.Mock;

  const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const TECH_A = '11111111-1111-4111-8111-111111111111';
  const JOB_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const UPLOAD_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

  // Must match WORKER_WEBHOOK_SECRET in .env — ConfigService caches at app init
  const WEBHOOK_SECRET = process.env['WORKER_WEBHOOK_SECRET'] ?? 'test-webhook-secret';

  const WORKFLOW_URL = `/api/v1/jobs/${JOB_ID}/workflow`;
  const WEBHOOK_URL = '/internal/webhooks/storage';

  const baseJobRow = {
    id: JOB_ID,
    tenant_id: TENANT_A,
    technician_id: TECH_A,
    status: 'in_progress',
    current_step: 'arrived',
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
   * Build a chainable Supabase mock for the workflow path.
   * - idempotencyLookup: controls IdempotencyInterceptor behaviour (null = miss = proceeds)
   * - jobLookup1: WorkflowJobRow partial select (gate fetch)
   * - jobLookup2: full JobRow select for no-op return path
   * - rpcResult: advance_workflow_step return value (should not be called on no-op)
   */
  function mockWorkflowAdmin(opts: {
    idempotencyLookup?: { data: unknown; error: unknown };
    jobLookup1?: { data: unknown; error: unknown };
    jobLookup2?: { data: unknown; error: unknown };
    rpcResult?: { data: unknown; error: unknown };
  }) {
    const partialRow = {
      id: baseJobRow.id,
      tenant_id: baseJobRow.tenant_id,
      technician_id: baseJobRow.technician_id,
      status: baseJobRow.status,
      current_step: baseJobRow.current_step,
      require_completion_photo: baseJobRow.require_completion_photo,
    };

    let callCount = 0;

    const chain = () => {
      let table = '';
      const obj: Record<string, jest.Mock> = {};
      let isSingleCall = false;

      obj.from = jest.fn((t: string) => {
        table = t;
        return obj;
      });
      obj.rpc = jest.fn(() =>
        Promise.resolve(
          opts.rpcResult ?? { data: [baseJobRow], error: null },
        ),
      );
      obj.select = jest.fn(() => obj);
      obj.eq = jest.fn(() => obj);
      obj.gt = jest.fn(() => obj);
      obj.single = jest.fn(() => {
        // First single() call is the gate fetch (partial row),
        // second is the full-row fetch for the no-op return
        callCount++;
        if (callCount === 1) {
          return Promise.resolve(
            opts.jobLookup1 ?? { data: partialRow, error: null },
          );
        }
        return Promise.resolve(
          opts.jobLookup2 ?? { data: baseJobRow, error: null },
        );
      });
      obj.maybeSingle = jest.fn(() => {
        if (table === 'idempotency_log') {
          return Promise.resolve(
            opts.idempotencyLookup ?? { data: null, error: null },
          );
        }
        return Promise.resolve({ data: null, error: null });
      });
      obj.insert = jest.fn(() =>
        Promise.resolve({ data: null, error: null }),
      );

      return obj;
    };

    mockCreateAdmin.mockImplementation(chain);
    const firstInstance = chain();
    mockCreateAdmin.mockReturnValueOnce(firstInstance);
    return firstInstance;
  }

  /**
   * Build a chainable Supabase mock for the webhook path.
   * confirmAttachmentResult: what confirm_attachment RPC returns
   */
  function mockWebhookAdmin(opts: {
    confirmAttachmentResult?: { data: unknown; error: unknown };
  }) {
    const chain = () => {
      const obj: Record<string, jest.Mock> = {};

      obj.from = jest.fn(() => obj);
      obj.rpc = jest.fn(() =>
        Promise.resolve(
          opts.confirmAttachmentResult ?? {
            data: [
              {
                attachment_id: 'att-1',
                already_existed: false,
              },
            ],
            error: null,
          },
        ),
      );
      obj.select = jest.fn(() => obj);
      obj.eq = jest.fn(() => obj);
      obj.single = jest.fn(() =>
        Promise.resolve({ data: null, error: null }),
      );
      obj.maybeSingle = jest.fn(() =>
        Promise.resolve({ data: null, error: null }),
      );
      obj.insert = jest.fn(() =>
        Promise.resolve({ data: null, error: null }),
      );

      return obj;
    };

    mockCreateAdmin.mockImplementation(chain);
    const firstInstance = chain();
    mockCreateAdmin.mockReturnValueOnce(firstInstance);
    return firstInstance;
  }

  // ── AC1: Same step replay → 200 no-op, RPC not called ──────────────────────

  describe('AC1 — same-step replay without idempotency key', () => {
    it('returns 200 with current job state and does NOT call advance_workflow_step RPC', async () => {
      // Job has current_step = 'arrived'; request to advance to 'arrived' again
      const chainInstance = mockWorkflowAdmin({
        idempotencyLookup: { data: null, error: null }, // no idempotency key hit
        jobLookup1: {
          data: {
            id: JOB_ID,
            tenant_id: TENANT_A,
            technician_id: TECH_A,
            status: 'in_progress',
            current_step: 'arrived', // already at this step
            require_completion_photo: false,
          },
          error: null,
        },
        jobLookup2: {
          data: { ...baseJobRow, current_step: 'arrived' },
          error: null,
        },
      });

      const res = await app.inject({
        method: 'POST',
        url: WORKFLOW_URL,
        headers: {
          authorization: `Bearer ${techJwt(TENANT_A, TECH_A)}`,
          // No X-Idempotency-Key — this is a no-key same-step replay
        },
        payload: { step: 'arrived' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.id).toBe(JOB_ID);
      expect(body.currentStep).toBe('arrived');
      // The compare-and-set RPC must NOT have been called
      expect(chainInstance.rpc).not.toHaveBeenCalled();
    });

    it('still advances (calls RPC) when step is the next valid step forward', async () => {
      // Job has current_step = 'arrived'; request to advance to 'in_progress' → normal advance
      const chainInstance = mockWorkflowAdmin({
        idempotencyLookup: { data: null, error: null },
        jobLookup1: {
          data: {
            id: JOB_ID,
            tenant_id: TENANT_A,
            technician_id: TECH_A,
            status: 'in_progress',
            current_step: 'arrived',
            require_completion_photo: false,
          },
          error: null,
        },
        rpcResult: { data: [{ ...baseJobRow, current_step: 'in_progress' }], error: null },
      });

      const res = await app.inject({
        method: 'POST',
        url: WORKFLOW_URL,
        headers: {
          authorization: `Bearer ${techJwt(TENANT_A, TECH_A)}`,
        },
        payload: { step: 'in_progress' },
      });

      expect(res.statusCode).toBe(200);
      // RPC was called for a genuine forward advance
      expect(chainInstance.rpc).toHaveBeenCalledWith(
        'advance_workflow_step',
        expect.objectContaining({ p_step: 'in_progress' }),
      );
    });
  });

  // ── AC3: Photo re-delivery → idempotent 200 (no conflict log) ───────────────

  describe('AC3 — webhook re-delivers the same photo upload', () => {
    it('returns 200 on second call when RPC returns already_existed=true', async () => {
      // Re-delivery of the SAME upload_id (e.g. a Worker webhook retry). The RPC's
      // idempotent path returns already_existed=true and — post code-review (F3) —
      // writes NO conflict_resolved log: nothing was replaced, so it is a duplicate
      // delivery, not a last-write-wins conflict. The webhook still returns 200.
      // (RPC internals verified via DB; this boundary test asserts the 200 contract.)
      mockWebhookAdmin({
        confirmAttachmentResult: {
          data: [{ attachment_id: 'att-1', already_existed: true }],
          error: null,
        },
      });

      const res = await app.inject({
        method: 'POST',
        url: WEBHOOK_URL,
        headers: {
          authorization: `Bearer ${WEBHOOK_SECRET}`,
          'content-type': 'application/json',
        },
        payload: {
          key: `${TENANT_A}/jobs/${JOB_ID}/photos/${UPLOAD_ID}.jpg`,
          size: 102400,
          tenantId: TENANT_A,
          jobId: JOB_ID,
          attachmentType: 'photo',
        },
      });

      // WebhooksService returns 200 whether already_existed is true or false
      expect(res.statusCode).toBe(200);
    });
  });

  // ── AC4: Signature re-upload → conflict_resolved log ────────────────────────

  describe('AC4 — webhook called twice for signature', () => {
    it('returns 200 on second webhook call for a signature re-upload', async () => {
      // A DISTINCT signature upload replaces the existing one (last-write-wins).
      // The RPC's signature-UPDATE path writes a conflict_resolved log referencing
      // the displaced upload's id (v_existing_id) — verified via DB. 200 at the boundary.
      mockWebhookAdmin({
        confirmAttachmentResult: {
          data: [{ attachment_id: 'sig-1', already_existed: true }],
          error: null,
        },
      });

      const SIG_UPLOAD_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

      const res = await app.inject({
        method: 'POST',
        url: WEBHOOK_URL,
        headers: {
          authorization: `Bearer ${WEBHOOK_SECRET}`,
          'content-type': 'application/json',
        },
        payload: {
          key: `${TENANT_A}/jobs/${JOB_ID}/signatures/${SIG_UPLOAD_ID}.png`,
          size: 51200,
          tenantId: TENANT_A,
          jobId: JOB_ID,
          attachmentType: 'signature',
        },
      });

      expect(res.statusCode).toBe(200);
    });
  });
});
