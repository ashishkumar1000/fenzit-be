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

describe('Sync (e2e)', () => {
  let app: NestFastifyApplication;
  let jwtService: JwtService;
  let mockCreate: jest.Mock;

  const TENANT_ID = 'tenant-uuid-sync-e2e';
  const TECH_ID = '33333333-3333-4333-8333-333333333333';
  const OWNER_ID = 'owner-uuid-sync-e2e';

  const jobRow = (updatedAt: string) => ({
    id: 'job-uuid-sync-1',
    job_number: 'JB-2026-0001',
    tenant_id: TENANT_ID,
    customer_id: 'cust-uuid-1',
    technician_id: TECH_ID,
    service_location: '12 MG Road',
    service_type: 'ac_service',
    scheduled_start: '2026-06-22T09:30:00Z',
    scheduled_end: null,
    status: 'scheduled',
    current_step: null,
    priority: 'normal',
    require_completion_photo: false,
    description: null,
    notes_for_technician: null,
    created_at: '2026-06-21T00:00:00Z',
    updated_at: updatedAt,
    customers: { name: 'Ravi Kumar', address: '12 MG Road, Bengaluru' },
    attachments: [],
  });

  beforeAll(async () => {
    mockCreate = jest.fn();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SupabaseClientFactory)
      .useValue({ create: mockCreate, createAdmin: jest.fn() })
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

  function techJwt(techId: string = TECH_ID) {
    return jwtService.sign({
      sub: techId,
      tenantId: TENANT_ID,
      role: 'technician',
    });
  }

  function ownerJwt() {
    return jwtService.sign({
      sub: OWNER_ID,
      tenantId: TENANT_ID,
      role: 'owner',
    });
  }

  function buildChain(rows: any[]) {
    // The service conditionally calls .gt() before .order().
    // We need the chain to support both code paths:
    //   - no lastSyncedAt: select → eq → order
    //   - with lastSyncedAt: select → eq → gt → order
    // .order() must be the terminal resolver in all paths.
    let chain: any;
    chain = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      gt: jest.fn().mockReturnThis(),
      order: jest.fn().mockResolvedValue({ data: rows, error: null }),
    };
    mockCreate.mockReturnValue({ from: jest.fn().mockReturnValue(chain) });
    return chain;
  }

  describe('POST /api/v1/sync', () => {
    it('AC1 — initial sync (null lastSyncedAt) returns all technician jobs', async () => {
      const row = jobRow('2026-06-21T08:00:00Z');
      const chain = buildChain([row]);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/sync',
        headers: { authorization: `Bearer ${techJwt()}` },
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.serverTime).toBeDefined();
      expect(body.jobs).toHaveLength(1);
      expect(body.jobs[0].id).toBe('job-uuid-sync-1');
      expect(body.jobs[0].customer).toEqual({
        name: 'Ravi Kumar',
        address: '12 MG Road, Bengaluru',
      });
      expect(body.jobs[0].attachments).toEqual([]);
      // gt() should NOT have been called for initial sync
      expect(chain.gt).not.toHaveBeenCalled();
    });

    it('AC2 — delta sync with lastSyncedAt applies gt filter', async () => {
      const row = jobRow('2026-06-21T10:00:00Z');
      const chain = buildChain([row]);
      const lastSyncedAt = '2026-06-21T09:00:00Z';

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/sync',
        headers: { authorization: `Bearer ${techJwt()}` },
        payload: { lastSyncedAt },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.jobs).toHaveLength(1);
      expect(chain.gt).toHaveBeenCalledWith('updated_at', lastSyncedAt);
    });

    it('AC3 — empty delta returns { jobs: [], serverTime }', async () => {
      buildChain([]);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/sync',
        headers: { authorization: `Bearer ${techJwt()}` },
        payload: { lastSyncedAt: '2026-06-21T12:00:00Z' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.jobs).toEqual([]);
      expect(body.serverTime).toBeDefined();
    });

    it('AC5 — owner JWT returns 403', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/sync',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: {},
      });

      expect(res.statusCode).toBe(403);
    });

    it('AC6 — invalid lastSyncedAt format returns 422', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/sync',
        headers: { authorization: `Bearer ${techJwt()}` },
        payload: { lastSyncedAt: 'not-a-date' },
      });

      expect(res.statusCode).toBe(422);
    });

    it('serverTime is returned as valid ISO 8601 UTC', async () => {
      buildChain([]);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/sync',
        headers: { authorization: `Bearer ${techJwt()}` },
        payload: {},
      });

      const body = JSON.parse(res.body);
      expect(new Date(body.serverTime).toISOString()).toBe(body.serverTime);
    });
  });
});
