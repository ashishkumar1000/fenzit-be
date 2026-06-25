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

describe('Jobs (e2e)', () => {
  let app: NestFastifyApplication;
  let jwtService: JwtService;
  let mockCreateAdmin: jest.Mock;

  const TENANT_ID = 'tenant-uuid-jobs-e2e';
  const OWNER_ID = 'owner-uuid-jobs-e2e';
  const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
  const TECH_ID = '22222222-2222-4222-8222-222222222222';

  beforeAll(async () => {
    mockCreateAdmin = jest.fn();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SupabaseClientFactory)
      .useValue({ create: jest.fn(), createAdmin: mockCreateAdmin })
      .overrideProvider(StorageService)
      .useValue({
        getPresignedUploadUrl: jest
          .fn()
          .mockResolvedValue('https://r2.example.com/presigned'),
        getPresignedReadUrl: jest
          .fn()
          .mockResolvedValue('https://r2.example.com/read'),
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

  function ownerJwt(tenantId: string | null = TENANT_ID) {
    return jwtService.sign({ sub: OWNER_ID, tenantId, role: 'owner' });
  }

  function techJwt() {
    return jwtService.sign({
      sub: 'tech-uuid',
      tenantId: TENANT_ID,
      role: 'technician',
    });
  }

  const jobRow = {
    id: 'job-uuid-1',
    job_number: 'JB-2026-0001',
    tenant_id: TENANT_ID,
    customer_id: CUSTOMER_ID,
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
    updated_at: '2026-06-21T00:00:00Z',
  };

  const validPayload = {
    customerId: CUSTOMER_ID,
    serviceLocation: '12 MG Road',
    serviceType: 'ac_service',
    scheduledStart: '2026-06-22T09:30:00Z',
    technicianId: TECH_ID,
  };

  const customerOk = {
    data: { id: CUSTOMER_ID, tenant_id: TENANT_ID },
    error: null,
  };
  const technicianOk = {
    data: { id: TECH_ID, tenant_id: TENANT_ID, role: 'technician' },
    error: null,
  };
  const notFound = { data: null, error: { code: 'PGRST116' } };

  function singleChain(
    result: { data: unknown; error: unknown },
    eqCount: number,
  ) {
    const single = jest.fn().mockResolvedValue(result);
    let node: Record<string, unknown> = { single };
    for (let i = 0; i < eqCount; i++) {
      const inner = node;
      node = { eq: jest.fn().mockReturnValue(inner) };
    }
    return { select: jest.fn().mockReturnValue(node) };
  }

  // select().eq(key).eq(tenant_id).eq(scope).gt().maybeSingle() chain for the
  // idempotency_log lookup, plus an insert() that resolves (IdempotencyInterceptor).
  function idempotencyChain(result: { data: unknown; error: unknown }) {
    const maybeSingle = jest.fn().mockResolvedValue(result);
    const gt = jest.fn().mockReturnValue({ maybeSingle });
    const eq3 = jest.fn().mockReturnValue({ gt });
    const eq2 = jest.fn().mockReturnValue({ eq: eq3 });
    const eq1 = jest.fn().mockReturnValue({ eq: eq2 });
    const select = jest.fn().mockReturnValue({ eq: eq1 });
    const insert = jest.fn().mockResolvedValue({ error: null });
    return { select, insert };
  }

  function mockAdmin(opts: {
    customer?: { data: unknown; error: unknown };
    technician?: { data: unknown; error: unknown };
    job?: { data: unknown; error: unknown };
    idempotency?: { data: unknown; error: unknown };
    rpc?: { data: unknown; error: unknown };
  }) {
    const from = jest.fn((table: string) => {
      if (table === 'customers')
        return singleChain(opts.customer ?? customerOk, 2);
      if (table === 'users')
        return singleChain(opts.technician ?? technicianOk, 3);
      if (table === 'jobs')
        return singleChain(opts.job ?? { data: jobRow, error: null }, 2);
      if (table === 'idempotency_log')
        return idempotencyChain(
          opts.idempotency ?? { data: null, error: null },
        );
      throw new Error(`unexpected table ${table}`);
    });
    const rpc = jest
      .fn()
      .mockResolvedValue(opts.rpc ?? { data: [jobRow], error: null });
    mockCreateAdmin.mockReturnValue({ from, rpc });
  }

  describe('POST /api/v1/jobs', () => {
    it('AC1 — returns 201 with the created job (existing customer)', async () => {
      mockAdmin({});

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/jobs',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: validPayload,
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.jobNumber).toBe('JB-2026-0001');
      expect(body.status).toBe('scheduled');
      expect(body.currentStep).toBeNull();
      expect(body.tenantId).toBe(TENANT_ID);
      expect(body.customerId).toBe(CUSTOMER_ID);
      expect(body.technicianId).toBe(TECH_ID);
    });

    it('AC4 — returns 404 RESOURCE_NOT_FOUND when technician is not in tenant', async () => {
      mockAdmin({ technician: notFound });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/jobs',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: validPayload,
      });

      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.body).error_code).toBe('RESOURCE_NOT_FOUND');
    });

    it('AC5 — returns 404 RESOURCE_NOT_FOUND when customerId is not in tenant', async () => {
      mockAdmin({ customer: notFound });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/jobs',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: validPayload,
      });

      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.body).error_code).toBe('RESOURCE_NOT_FOUND');
    });

    it('AC6 — returns 422 VALIDATION_ERROR for an invalid serviceType', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/jobs',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { ...validPayload, serviceType: 'teleportation' },
      });

      expect(response.statusCode).toBe(422);
      expect(JSON.parse(response.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('AC6 — returns 422 VALIDATION_ERROR for a malformed technicianId UUID', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/jobs',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { ...validPayload, technicianId: 'not-a-uuid' },
      });

      expect(response.statusCode).toBe(422);
      expect(JSON.parse(response.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('AC6 — returns 422 VALIDATION_ERROR for a malformed (non-ISO) scheduledStart', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/jobs',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { ...validPayload, scheduledStart: '22-06-2026 9am' },
      });

      expect(response.statusCode).toBe(422);
      expect(JSON.parse(response.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('AC6 — returns 422 VALIDATION_ERROR when scheduledEnd is before scheduledStart', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/jobs',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: {
          ...validPayload,
          scheduledStart: '2026-06-22T11:00:00Z',
          scheduledEnd: '2026-06-22T09:30:00Z',
        },
      });

      expect(response.statusCode).toBe(422);
      expect(JSON.parse(response.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('AC6 — returns 422 VALIDATION_ERROR when scheduledStart is missing', async () => {
      const { scheduledStart, ...payload } = validPayload;
      void scheduledStart;

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/jobs',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload,
      });

      expect(response.statusCode).toBe(422);
      expect(JSON.parse(response.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('AC6 — returns 422 when neither customerId nor newCustomer is provided', async () => {
      const { customerId, ...payload } = validPayload;
      void customerId;

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/jobs',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload,
      });

      expect(response.statusCode).toBe(422);
      expect(JSON.parse(response.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('AC6 — returns 422 when both customerId and newCustomer are provided', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/jobs',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: {
          ...validPayload,
          newCustomer: {
            name: 'Priya',
            countryCode: '+91',
            phoneNumber: '9876543210',
          },
        },
      });

      expect(response.statusCode).toBe(422);
      expect(JSON.parse(response.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('AC7 — returns 403 FORBIDDEN for a Technician JWT', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/jobs',
        headers: { authorization: `Bearer ${techJwt()}` },
        payload: validPayload,
      });

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body).error_code).toBe('FORBIDDEN');
    });

    it('AC8 — returns 401 UNAUTHORIZED with no Authorization header', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/jobs',
        payload: validPayload,
      });

      expect(response.statusCode).toBe(401);
      expect(JSON.parse(response.body).error_code).toBe('UNAUTHORIZED');
    });

    it('AC9 — returns 400 VALIDATION_ERROR when the owner has no tenantId', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/jobs',
        headers: { authorization: `Bearer ${ownerJwt(null)}` },
        payload: validPayload,
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error_code).toBe('VALIDATION_ERROR');
    });
  });

  describe('GET /api/v1/jobs', () => {
    // GET path terminal is `.limit()` (awaited → { data, error }), not `.single()`.
    function listChain(result: { data: unknown; error: unknown }) {
      const builder: Record<string, jest.Mock> = {};
      for (const m of ['select', 'eq', 'gte', 'lt', 'in', 'or', 'order']) {
        builder[m] = jest.fn().mockReturnValue(builder);
      }
      builder.limit = jest.fn().mockResolvedValue(result);
      return builder;
    }

    function mockList(result: { data: unknown; error: unknown }) {
      const builder = listChain(result);
      const from = jest.fn((table: string) => {
        if (table === 'jobs') return builder;
        throw new Error(`unexpected table ${table}`);
      });
      mockCreateAdmin.mockReturnValue({ from });
      return { from, builder };
    }

    it('AC1 — returns 200 with a cursor-paginated job list (owner, today)', async () => {
      mockList({ data: [jobRow], error: null });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/jobs',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].jobNumber).toBe('JB-2026-0001');
      expect(body.nextCursor).toBeNull();
      expect(body.hasMore).toBe(false);
    });

    it('AC2 — accepts a repeatable status filter', async () => {
      const { builder } = mockList({ data: [], error: null });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/jobs?status=scheduled&status=in_progress',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(200);
      expect(builder.in).toHaveBeenCalledWith('status', [
        'scheduled',
        'in_progress',
      ]);
    });

    it('AC3 — accepts an explicit date', async () => {
      const { builder } = mockList({ data: [], error: null });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/jobs?date=2026-06-20',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(200);
      expect(builder.gte).toHaveBeenCalledWith(
        'scheduled_start',
        '2026-06-19T18:30:00.000Z',
      );
    });

    it('AC4 — owner can filter by technicianId', async () => {
      const { builder } = mockList({ data: [], error: null });

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/jobs?technicianId=${TECH_ID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(200);
      expect(builder.eq).toHaveBeenCalledWith('technician_id', TECH_ID);
    });

    it('AC5 — technician is self-scoped; query technicianId is ignored', async () => {
      const { builder } = mockList({ data: [], error: null });

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/jobs?technicianId=${TECH_ID}`,
        headers: { authorization: `Bearer ${techJwt()}` },
      });

      expect(response.statusCode).toBe(200);
      expect(builder.eq).toHaveBeenCalledWith('technician_id', 'tech-uuid');
      expect(builder.eq).not.toHaveBeenCalledWith('technician_id', TECH_ID);
    });

    it('AC6 — returns 200 with an empty array when nothing matches (not 404)', async () => {
      mockList({ data: [], error: null });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/jobs',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toEqual([]);
      expect(body.nextCursor).toBeNull();
      expect(body.hasMore).toBe(false);
    });

    it('AC7 — accepts a valid cursor', async () => {
      mockList({ data: [jobRow], error: null });
      const cursor = Buffer.from(
        JSON.stringify({
          id: CUSTOMER_ID,
          createdAt: '2026-06-21T00:00:00.000Z',
        }),
      ).toString('base64url');

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/jobs?cursor=${cursor}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(200);
    });

    it('AC8 — returns 400 VALIDATION_ERROR for a malformed cursor', async () => {
      mockList({ data: [], error: null });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/jobs?cursor=not-a-real-cursor',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('AC9 — returns 422 for a malformed technicianId UUID', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/jobs?technicianId=not-a-uuid',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(422);
      expect(JSON.parse(response.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('AC9 — returns 422 for a malformed date', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/jobs?date=2026-6-1',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(422);
      expect(JSON.parse(response.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('AC9 — returns 422 for an impossible calendar date (month 13), not 500', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/jobs?date=2026-13-01',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(422);
      expect(JSON.parse(response.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('AC9 — returns 422 for a rollover date (2026-02-30), not a silent wrong-day 200', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/jobs?date=2026-02-30',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(422);
      expect(JSON.parse(response.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('AC10 — returns 401 with no Authorization header', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/v1/jobs' });

      expect(response.statusCode).toBe(401);
      expect(JSON.parse(response.body).error_code).toBe('UNAUTHORIZED');
    });

    it('AC11 — returns 400 when the owner has no tenantId', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/jobs',
        headers: { authorization: `Bearer ${ownerJwt(null)}` },
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error_code).toBe('VALIDATION_ERROR');
    });
  });

  describe('GET /api/v1/jobs/:id', () => {
    const JOB_UUID = '33333333-3333-4333-8333-333333333333';
    const technicianRow = {
      id: TECH_ID,
      name: 'Ravi',
      country_code: '+91',
      phone_number: '9990001111',
    };
    const customerRow = {
      id: CUSTOMER_ID,
      name: 'Priya',
      country_code: '+91',
      phone_number: '9876543210',
      address: '12 MG Road',
      city: 'Pune',
    };
    const skillRows = [{ tenant_skills: { name: 'AC Repair' } }];
    const logRows = [
      {
        id: 'log-1',
        event_type: 'job_created',
        actor_id: OWNER_ID,
        metadata: {},
        created_at: '2026-06-21T00:00:00Z',
      },
      {
        id: 'log-2',
        event_type: 'step_on_my_way',
        actor_id: 'tech-uuid',
        metadata: null,
        created_at: '2026-06-21T02:00:00Z',
      },
    ];
    // techJwt() carries sub: 'tech-uuid' → a job assigned to that technician.
    const ownJobRow = { ...jobRow, technician_id: 'tech-uuid' };

    function mockDetail(opts: {
      job?: { data: unknown; error: unknown };
      technician?: { data: unknown; error: unknown };
      skills?: { data: unknown; error: unknown };
      customer?: { data: unknown; error: unknown };
      logs?: { data: unknown; error: unknown };
      attachments?: { data: unknown; error: unknown };
    }) {
      const from = jest.fn((table: string) => {
        if (table === 'jobs')
          return singleChain(opts.job ?? { data: jobRow, error: null }, 2);
        if (table === 'users')
          return singleChain(
            opts.technician ?? { data: technicianRow, error: null },
            2,
          );
        if (table === 'customers')
          return singleChain(
            opts.customer ?? { data: customerRow, error: null },
            2,
          );
        if (table === 'user_skills') {
          const eq2 = jest
            .fn()
            .mockResolvedValue(opts.skills ?? { data: skillRows, error: null });
          const eq1 = jest.fn().mockReturnValue({ eq: eq2 });
          return { select: jest.fn().mockReturnValue({ eq: eq1 }) };
        }
        if (table === 'activity_logs') {
          const order = jest
            .fn()
            .mockResolvedValue(opts.logs ?? { data: logRows, error: null });
          const eq2 = jest.fn().mockReturnValue({ order });
          const eq1 = jest.fn().mockReturnValue({ eq: eq2 });
          return { select: jest.fn().mockReturnValue({ eq: eq1 }) };
        }
        if (table === 'attachments') {
          const order = jest
            .fn()
            .mockResolvedValue(opts.attachments ?? { data: [], error: null });
          const eq2 = jest.fn().mockReturnValue({ order });
          const eq1 = jest.fn().mockReturnValue({ eq: eq2 });
          return { select: jest.fn().mockReturnValue({ eq: eq1 }) };
        }
        throw new Error(`unexpected table ${table}`);
      });
      mockCreateAdmin.mockReturnValue({ from });
    }

    it('AC1 — returns 200 with the full job detail (owner)', async () => {
      mockDetail({});

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/jobs/${JOB_UUID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.jobNumber).toBe('JB-2026-0001');
      expect(body.technician).toEqual({
        id: TECH_ID,
        name: 'Ravi',
        countryCode: '+91',
        phoneNumber: '9990001111',
        skills: ['AC Repair'],
      });
      expect(body.customer).toEqual({
        id: CUSTOMER_ID,
        name: 'Priya',
        countryCode: '+91',
        phoneNumber: '9876543210',
        address: '12 MG Road',
        city: 'Pune',
      });
      // AC5 — activity log oldest-first.
      expect(body.activityLog.map((l: { id: string }) => l.id)).toEqual([
        'log-1',
        'log-2',
      ]);
      // AC18 — attachments populated with presigned read URLs (empty when none)
      expect(body.attachments).toEqual([]);
    });

    it('AC4 — a technician can view their own assigned job', async () => {
      mockDetail({ job: { data: ownJobRow, error: null } });

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/jobs/${JOB_UUID}`,
        headers: { authorization: `Bearer ${techJwt()}` },
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).id).toBe('job-uuid-1');
    });

    it('AC4 — returns 403 FORBIDDEN when a technician requests a job not theirs', async () => {
      mockDetail({}); // default jobRow.technician_id = TECH_ID (not 'tech-uuid')

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/jobs/${JOB_UUID}`,
        headers: { authorization: `Bearer ${techJwt()}` },
      });

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body).error_code).toBe('FORBIDDEN');
    });

    it('AC2/AC3 — returns 404 RESOURCE_NOT_FOUND for a missing / cross-tenant job', async () => {
      mockDetail({ job: { data: null, error: { code: 'PGRST116' } } });

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/jobs/${JOB_UUID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.body).error_code).toBe('RESOURCE_NOT_FOUND');
    });

    it('AC7 — returns 400 for a malformed (non-UUID) id', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/jobs/not-a-uuid',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(400);
    });

    it('AC9 — returns 401 with no Authorization header', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/jobs/${JOB_UUID}`,
      });

      expect(response.statusCode).toBe(401);
      expect(JSON.parse(response.body).error_code).toBe('UNAUTHORIZED');
    });

    it('AC8 — returns 400 when the owner has no tenantId', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/jobs/${JOB_UUID}`,
        headers: { authorization: `Bearer ${ownerJwt(null)}` },
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error_code).toBe('VALIDATION_ERROR');
    });
  });

  describe('PATCH /api/v1/jobs/:id', () => {
    const JOB_UUID = '44444444-4444-4444-8444-444444444444';

    it('AC1 — owner edits a scheduled job → 200 with the updated job', async () => {
      mockAdmin({
        rpc: { data: [{ ...jobRow, description: 'edited' }], error: null },
      });

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/jobs/${JOB_UUID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { description: 'edited', priority: 'urgent' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.jobNumber).toBe('JB-2026-0001');
      expect(body.description).toBe('edited');
    });

    it('AC2 — owner reassigns to a valid technician → 200', async () => {
      mockAdmin({});

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/jobs/${JOB_UUID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { technicianId: TECH_ID },
      });

      expect(response.statusCode).toBe(200);
    });

    it('AC3 — owner cancels a scheduled job → 200 with status cancelled', async () => {
      mockAdmin({
        rpc: { data: [{ ...jobRow, status: 'cancelled' }], error: null },
      });

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/jobs/${JOB_UUID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { status: 'cancelled' },
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).status).toBe('cancelled');
    });

    it('AC4 — returns 409 JOB_NOT_MODIFIABLE for a non-scheduled job (RPC PT409)', async () => {
      mockAdmin({
        rpc: {
          data: null,
          error: { code: 'PT409', message: 'not modifiable' },
        },
      });

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/jobs/${JOB_UUID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { description: 'x' },
      });

      expect(response.statusCode).toBe(409);
      expect(JSON.parse(response.body).error_code).toBe('JOB_NOT_MODIFIABLE');
    });

    it('AC6 — returns 403 FORBIDDEN for a Technician JWT', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/jobs/${JOB_UUID}`,
        headers: { authorization: `Bearer ${techJwt()}` },
        payload: { description: 'x' },
      });

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body).error_code).toBe('FORBIDDEN');
    });

    it('AC7 — returns 404 when the new technician is not in the tenant', async () => {
      mockAdmin({ technician: notFound });

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/jobs/${JOB_UUID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { technicianId: TECH_ID },
      });

      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.body).error_code).toBe('RESOURCE_NOT_FOUND');
    });

    it('AC8 — returns 404 for a missing / cross-tenant job (RPC empty)', async () => {
      mockAdmin({ rpc: { data: [], error: null } });

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/jobs/${JOB_UUID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { description: 'x' },
      });

      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.body).error_code).toBe('RESOURCE_NOT_FOUND');
    });

    it('AC9 — returns 400 for a malformed (non-UUID) id', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/v1/jobs/not-a-uuid',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { description: 'x' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('AC11 — returns 401 with no Authorization header', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/jobs/${JOB_UUID}`,
        payload: { description: 'x' },
      });

      expect(response.statusCode).toBe(401);
      expect(JSON.parse(response.body).error_code).toBe('UNAUTHORIZED');
    });

    it('AC10 — returns 400 when the owner has no tenantId', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/jobs/${JOB_UUID}`,
        headers: { authorization: `Bearer ${ownerJwt(null)}` },
        payload: { description: 'x' },
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('AC12 — returns 422 for an empty body (no updatable fields)', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/jobs/${JOB_UUID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: {},
      });

      expect(response.statusCode).toBe(422);
      expect(JSON.parse(response.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('AC14 — returns 422 when cancellation is combined with a field edit', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/jobs/${JOB_UUID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { status: 'cancelled', description: 'x' },
      });

      expect(response.statusCode).toBe(422);
      expect(JSON.parse(response.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('AC13 — returns 422 for a status value other than cancelled', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/jobs/${JOB_UUID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { status: 'completed' },
      });

      expect(response.statusCode).toBe(422);
      expect(JSON.parse(response.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('AC15 — returns 422 when scheduledEnd is before scheduledStart', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/jobs/${JOB_UUID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: {
          scheduledStart: '2026-06-22T11:00:00Z',
          scheduledEnd: '2026-06-22T09:30:00Z',
        },
      });

      expect(response.statusCode).toBe(422);
      expect(JSON.parse(response.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('AC15 — returns 422 when a one-sided edit inverts the stored window (RPC PT422)', async () => {
      mockAdmin({
        rpc: {
          data: null,
          error: {
            code: 'PT422',
            message: 'scheduled_end before scheduled_start',
          },
        },
      });

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/jobs/${JOB_UUID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { scheduledStart: '2026-06-22T23:00:00Z' },
      });

      expect(response.statusCode).toBe(422);
      expect(JSON.parse(response.body).error_code).toBe('VALIDATION_ERROR');
    });
  });

  describe('POST /api/v1/jobs/:id/workflow', () => {
    // A technician JWT whose sub IS the assignee (jobRow.technician_id = TECH_ID).
    function assignedTechJwt(tenantId: string | null = TENANT_ID) {
      return jwtService.sign({ sub: TECH_ID, tenantId, role: 'technician' });
    }
    const JOB_ID = '55555555-5555-4555-8555-555555555555';
    const WORKFLOW_URL = `/api/v1/jobs/${JOB_ID}/workflow`;

    // The job as fetched (assigned to TECH_ID, scheduled, no step yet).
    const fetchRow = {
      ...jobRow,
      id: JOB_ID,
      status: 'scheduled',
      current_step: null,
      technician_id: TECH_ID,
    };
    // The RPC's returned row after the on_my_way advance.
    const advancedRow = {
      ...fetchRow,
      status: 'in_progress',
      current_step: 'on_my_way',
    };

    it('AC1 — assigned technician advances on_my_way → 200 (status in_progress)', async () => {
      mockAdmin({
        job: { data: fetchRow, error: null },
        rpc: { data: [advancedRow], error: null },
      });

      const response = await app.inject({
        method: 'POST',
        url: WORKFLOW_URL,
        headers: { authorization: `Bearer ${assignedTechJwt()}` },
        payload: { step: 'on_my_way' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('in_progress');
      expect(body.currentStep).toBe('on_my_way');
    });

    it('AC9 — proceeds without an X-Idempotency-Key header', async () => {
      mockAdmin({
        job: { data: fetchRow, error: null },
        rpc: { data: [advancedRow], error: null },
      });

      const response = await app.inject({
        method: 'POST',
        url: WORKFLOW_URL,
        headers: { authorization: `Bearer ${assignedTechJwt()}` },
        payload: { step: 'on_my_way' },
      });

      expect(response.statusCode).toBe(200);
    });

    it('AC6 — out-of-order step → 422 INVALID_WORKFLOW_STEP with currentStep', async () => {
      mockAdmin({
        job: {
          data: {
            ...fetchRow,
            status: 'in_progress',
            current_step: 'on_my_way',
          },
          error: null,
        },
      });

      const response = await app.inject({
        method: 'POST',
        url: WORKFLOW_URL,
        headers: { authorization: `Bearer ${assignedTechJwt()}` },
        payload: { step: 'completed' },
      });

      expect(response.statusCode).toBe(422);
      const body = JSON.parse(response.body);
      expect(body.error_code).toBe('INVALID_WORKFLOW_STEP');
      expect(body.currentStep).toBe('on_my_way');
    });

    it('AC5 — skip photos when require_completion_photo=true → 422', async () => {
      mockAdmin({
        job: {
          data: {
            ...fetchRow,
            status: 'in_progress',
            current_step: 'in_progress',
            require_completion_photo: true,
          },
          error: null,
        },
      });

      const response = await app.inject({
        method: 'POST',
        url: WORKFLOW_URL,
        headers: { authorization: `Bearer ${assignedTechJwt()}` },
        payload: { step: 'signature_captured' },
      });

      expect(response.statusCode).toBe(422);
      expect(JSON.parse(response.body).error_code).toBe(
        'INVALID_WORKFLOW_STEP',
      );
    });

    it('AC10 — Owner JWT → 403 FORBIDDEN', async () => {
      mockAdmin({});

      const response = await app.inject({
        method: 'POST',
        url: WORKFLOW_URL,
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { step: 'on_my_way' },
      });

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body).error_code).toBe('FORBIDDEN');
    });

    it('AC11 — technician not the assignee → 403 FORBIDDEN', async () => {
      mockAdmin({ job: { data: fetchRow, error: null } });

      const response = await app.inject({
        method: 'POST',
        url: WORKFLOW_URL,
        // techJwt()'s sub is 'tech-uuid' — NOT the assignee (TECH_ID).
        headers: { authorization: `Bearer ${techJwt()}` },
        payload: { step: 'on_my_way' },
      });

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body).error_code).toBe('FORBIDDEN');
    });

    it('AC12 — missing/cross-tenant job → 404', async () => {
      mockAdmin({ job: { data: null, error: { code: 'PGRST116' } } });

      const response = await app.inject({
        method: 'POST',
        url: WORKFLOW_URL,
        headers: { authorization: `Bearer ${assignedTechJwt()}` },
        payload: { step: 'on_my_way' },
      });

      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.body).error_code).toBe('RESOURCE_NOT_FOUND');
    });

    it('AC17 — terminal-status job → 409 JOB_NOT_MODIFIABLE', async () => {
      mockAdmin({
        job: {
          data: { ...fetchRow, status: 'completed', current_step: 'completed' },
          error: null,
        },
      });

      const response = await app.inject({
        method: 'POST',
        url: WORKFLOW_URL,
        headers: { authorization: `Bearer ${assignedTechJwt()}` },
        payload: { step: 'on_my_way' },
      });

      expect(response.statusCode).toBe(409);
      expect(JSON.parse(response.body).error_code).toBe('JOB_NOT_MODIFIABLE');
    });

    it('AC16 — invalid step enum → 422 VALIDATION_ERROR', async () => {
      const response = await app.inject({
        method: 'POST',
        url: WORKFLOW_URL,
        headers: { authorization: `Bearer ${assignedTechJwt()}` },
        payload: { step: 'teleport' },
      });

      expect(response.statusCode).toBe(422);
      expect(JSON.parse(response.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('AC13 — malformed :id → 400', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/jobs/not-a-uuid/workflow',
        headers: { authorization: `Bearer ${assignedTechJwt()}` },
        payload: { step: 'on_my_way' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('AC14 — no-tenant technician JWT → 400 VALIDATION_ERROR', async () => {
      mockAdmin({});

      const response = await app.inject({
        method: 'POST',
        url: WORKFLOW_URL,
        headers: { authorization: `Bearer ${assignedTechJwt(null)}` },
        payload: { step: 'on_my_way' },
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('AC15 — no Authorization header → 401', async () => {
      const response = await app.inject({
        method: 'POST',
        url: WORKFLOW_URL,
        payload: { step: 'on_my_way' },
      });

      expect(response.statusCode).toBe(401);
      expect(JSON.parse(response.body).error_code).toBe('UNAUTHORIZED');
    });

    it('AC8 — X-Idempotency-Key cache hit → 200 with the original body, RPC not re-called', async () => {
      const cached = {
        id: JOB_ID,
        status: 'in_progress',
        currentStep: 'on_my_way',
      };
      mockAdmin({
        job: { data: fetchRow, error: null },
        idempotency: { data: { response_body: cached }, error: null },
        // If the RPC were called it would return advancedRow; assert we get `cached` instead.
        rpc: { data: [advancedRow], error: null },
      });

      const response = await app.inject({
        method: 'POST',
        url: WORKFLOW_URL,
        headers: {
          authorization: `Bearer ${assignedTechJwt()}`,
          'x-idempotency-key': '99999999-9999-4999-8999-999999999999',
        },
        payload: { step: 'on_my_way' },
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual(cached);
    });

    it('rejects a malformed X-Idempotency-Key → 422', async () => {
      mockAdmin({ job: { data: fetchRow, error: null } });

      const response = await app.inject({
        method: 'POST',
        url: WORKFLOW_URL,
        headers: {
          authorization: `Bearer ${assignedTechJwt()}`,
          'x-idempotency-key': 'not-a-uuid',
        },
        payload: { step: 'on_my_way' },
      });

      expect(response.statusCode).toBe(422);
      expect(JSON.parse(response.body).error_code).toBe('VALIDATION_ERROR');
    });
  });

  // ── Attachment upload routes ──────────────────────────────────────────────

  describe('POST /api/v1/jobs/:id/attachments', () => {
    const JOB_ID = '66666666-6666-4666-8666-666666666666';
    const UPLOAD_URL = `/api/v1/jobs/${JOB_ID}/attachments`;

    function assignedTechJwt(tenantId: string | null = TENANT_ID) {
      return jwtService.sign({ sub: TECH_ID, tenantId, role: 'technician' });
    }

    const fetchRow = { ...jobRow, id: JOB_ID, technician_id: TECH_ID };

    // Builds the full mock for attachment upload:
    // jobs single chain + attachments count chain (3 eqs → resolves) + attachment_uploads insert
    function mockAttachAdmin(opts: {
      job?: { data: unknown; error: unknown };
      count?: { count: number | null; error: unknown };
      insert?: { data: unknown; error: unknown };
      idempotency?: { data: unknown; error: unknown };
    }) {
      const from = jest.fn((table: string) => {
        if (table === 'jobs')
          return singleChain(opts.job ?? { data: fetchRow, error: null }, 2);
        if (table === 'attachments') {
          const result = opts.count ?? { count: 0, error: null };
          const eq3 = jest.fn().mockResolvedValue(result);
          const eq2 = jest.fn().mockReturnValue({ eq: eq3 });
          const eq1 = jest.fn().mockReturnValue({ eq: eq2 });
          return { select: jest.fn().mockReturnValue({ eq: eq1 }) };
        }
        if (table === 'attachment_uploads') {
          return {
            insert: jest
              .fn()
              .mockResolvedValue(opts.insert ?? { data: null, error: null }),
          };
        }
        if (table === 'idempotency_log')
          return idempotencyChain(
            opts.idempotency ?? { data: null, error: null },
          );
        throw new Error(`unexpected table: ${table}`);
      });
      mockCreateAdmin.mockReturnValue({ from, rpc: jest.fn() });
    }

    const photoPayload = {
      filename: 'photo.jpg',
      mimeType: 'image/jpeg',
      attachmentType: 'photo',
    };

    it('AC1 — photo request → 200 with presignedPutUrl, uploadId, key, expiresAt', async () => {
      mockAttachAdmin({});

      const response = await app.inject({
        method: 'POST',
        url: UPLOAD_URL,
        headers: { authorization: `Bearer ${assignedTechJwt()}` },
        payload: photoPayload,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.presignedPutUrl).toBe('https://r2.example.com/presigned');
      expect(body.uploadId).toMatch(/^[0-9a-f-]{36}$/);
      expect(body.key).toContain('/photos/');
      expect(body.expiresAt).toBeTruthy();
    });

    it('AC3 — invalid mimeType → 422', async () => {
      const response = await app.inject({
        method: 'POST',
        url: UPLOAD_URL,
        headers: { authorization: `Bearer ${assignedTechJwt()}` },
        payload: { ...photoPayload, mimeType: 'video/mp4' },
      });
      expect(response.statusCode).toBe(422);
    });

    it('AC4 — 5 photos already uploaded → 409 DUPLICATE_RESOURCE', async () => {
      mockAttachAdmin({ count: { count: 5, error: null } });

      const response = await app.inject({
        method: 'POST',
        url: UPLOAD_URL,
        headers: { authorization: `Bearer ${assignedTechJwt()}` },
        payload: photoPayload,
      });
      expect(response.statusCode).toBe(409);
      expect(JSON.parse(response.body).error_code).toBe('DUPLICATE_RESOURCE');
    });

    it('AC12 — Owner JWT → 403 FORBIDDEN', async () => {
      const response = await app.inject({
        method: 'POST',
        url: UPLOAD_URL,
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: photoPayload,
      });
      expect(response.statusCode).toBe(403);
    });

    it('AC13 — non-assignee technician → 403', async () => {
      mockAttachAdmin({
        job: {
          data: { ...fetchRow, technician_id: 'other-tech' },
          error: null,
        },
      });

      const response = await app.inject({
        method: 'POST',
        url: UPLOAD_URL,
        headers: { authorization: `Bearer ${assignedTechJwt()}` },
        payload: photoPayload,
      });
      expect(response.statusCode).toBe(403);
    });

    it('AC14 — job not found → 404', async () => {
      mockAttachAdmin({ job: { data: null, error: { code: 'PGRST116' } } });

      const response = await app.inject({
        method: 'POST',
        url: UPLOAD_URL,
        headers: { authorization: `Bearer ${assignedTechJwt()}` },
        payload: photoPayload,
      });
      expect(response.statusCode).toBe(404);
    });

    it('AC15 — malformed :id UUID → 400', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/jobs/not-a-uuid/attachments',
        headers: { authorization: `Bearer ${assignedTechJwt()}` },
        payload: photoPayload,
      });
      expect(response.statusCode).toBe(400);
    });

    it('AC16 — no-tenant JWT → 400', async () => {
      const response = await app.inject({
        method: 'POST',
        url: UPLOAD_URL,
        headers: { authorization: `Bearer ${assignedTechJwt(null)}` },
        payload: photoPayload,
      });
      expect(response.statusCode).toBe(400);
    });

    it('AC17 — no Authorization header → 401', async () => {
      const response = await app.inject({
        method: 'POST',
        url: UPLOAD_URL,
        payload: photoPayload,
      });
      expect(response.statusCode).toBe(401);
    });

    it('AC19 — idempotency replay → 200 same response', async () => {
      const cached = {
        presignedPutUrl: 'https://cached.url',
        uploadId: 'uuid',
        key: 'key',
        expiresAt: 'ts',
      };
      mockAttachAdmin({
        idempotency: { data: { response_body: cached }, error: null },
      });

      const response = await app.inject({
        method: 'POST',
        url: UPLOAD_URL,
        headers: {
          authorization: `Bearer ${assignedTechJwt()}`,
          'x-idempotency-key': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        },
        payload: photoPayload,
      });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual(cached);
    });
  });

  describe('POST /api/v1/jobs/:id/attachments/:uploadId/confirm', () => {
    const JOB_ID = '77777777-7777-4777-8777-777777777777';
    const UPLOAD_ID = '88888888-8888-4888-8888-888888888888';
    const CONFIRM_URL = `/api/v1/jobs/${JOB_ID}/attachments/${UPLOAD_ID}/confirm`;

    function assignedTechJwt(tenantId: string | null = TENANT_ID) {
      return jwtService.sign({ sub: TECH_ID, tenantId, role: 'technician' });
    }

    const fetchRow = { ...jobRow, id: JOB_ID, technician_id: TECH_ID };

    function mockConfirmAdmin(opts: {
      job?: { data: unknown; error: unknown };
      rpc?: { data: unknown; error: unknown };
    }) {
      const from = jest.fn((table: string) => {
        if (table === 'jobs')
          return singleChain(opts.job ?? { data: fetchRow, error: null }, 2);
        throw new Error(`unexpected table: ${table}`);
      });
      const rpc = jest.fn().mockResolvedValue(
        opts.rpc ?? {
          data: [
            {
              attachment_id: 'att-uuid',
              attachment_type: 'photo',
              created_at: '2026-06-21T00:00:00Z',
              already_existed: false,
            },
          ],
          error: null,
        },
      );
      mockCreateAdmin.mockReturnValue({ from, rpc });
    }

    it('AC5 — happy path → 200 { id, type, createdAt }', async () => {
      mockConfirmAdmin({});

      const response = await app.inject({
        method: 'POST',
        url: CONFIRM_URL,
        headers: { authorization: `Bearer ${assignedTechJwt()}` },
        payload: { sizeBytes: 12345 },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.id).toBe('att-uuid');
      expect(body.type).toBe('photo');
      expect(body.createdAt).toBeTruthy();
    });

    it('AC8 — expired upload → 410 GONE', async () => {
      mockConfirmAdmin({
        rpc: { data: null, error: { message: 'UPLOAD_EXPIRED' } },
      });

      const response = await app.inject({
        method: 'POST',
        url: CONFIRM_URL,
        headers: { authorization: `Bearer ${assignedTechJwt()}` },
        payload: { sizeBytes: 1 },
      });
      expect(response.statusCode).toBe(410);
    });

    it('AC12 — Owner JWT → 403', async () => {
      const response = await app.inject({
        method: 'POST',
        url: CONFIRM_URL,
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { sizeBytes: 1 },
      });
      expect(response.statusCode).toBe(403);
    });

    it('AC15 — malformed uploadId → 400', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/jobs/${JOB_ID}/attachments/not-a-uuid/confirm`,
        headers: { authorization: `Bearer ${assignedTechJwt()}` },
        payload: { sizeBytes: 1 },
      });
      expect(response.statusCode).toBe(400);
    });
  });

  // ── Webhook route (not under api/v1) ────────────────────────────────────

  describe('POST /internal/webhooks/storage', () => {
    // Must match the value ConfigService loaded at app bootstrap
    // (test/jest.env.setup.ts sets WORKER_WEBHOOK_SECRET); a runtime process.env
    // override has no effect because ConfigService caches at init.
    const WEBHOOK_SECRET = 'test-webhook-secret';
    // tenantId/jobId/uploadId are @IsUUID() in StorageEventDto and must be real
    // UUIDs, and the key must encode the same tenant/job (the service rejects a
    // key/body mismatch as defense-in-depth).
    const WH_TENANT = '11111111-1111-4111-8111-111111111111';
    const WH_JOB = '22222222-2222-4222-8222-222222222222';
    const WH_UPLOAD = '33333333-3333-4333-8333-333333333333';
    const webhookPayload = {
      key: `${WH_TENANT}/jobs/${WH_JOB}/photos/${WH_UPLOAD}.jpg`,
      size: 12345,
      tenantId: WH_TENANT,
      jobId: WH_JOB,
      attachmentType: 'photo',
    };

    function mockWebhookAdmin(rpcResult: { data: unknown; error: unknown }) {
      const rpc = jest.fn().mockResolvedValue(rpcResult);
      mockCreateAdmin.mockReturnValue({ rpc });
    }

    it('AC10 — valid secret → 200', async () => {
      mockWebhookAdmin({
        data: [{ attachment_id: 'att-uuid', attachment_type: 'photo' }],
        error: null,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/internal/webhooks/storage',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${WEBHOOK_SECRET}`,
        },
        payload: webhookPayload,
      });
      expect(response.statusCode).toBe(200);
    });

    it('AC11 — invalid secret → 401 UNAUTHORIZED', async () => {
      mockWebhookAdmin({ data: null, error: null });

      const response = await app.inject({
        method: 'POST',
        url: '/internal/webhooks/storage',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer wrong-secret',
        },
        payload: webhookPayload,
      });
      expect(response.statusCode).toBe(401);
      expect(JSON.parse(response.body).error_code).toBe('UNAUTHORIZED');
    });

    it('key/body tenant mismatch → 200 ack but RPC not called (defense-in-depth)', async () => {
      const rpc = jest.fn();
      mockCreateAdmin.mockReturnValue({ rpc });

      const response = await app.inject({
        method: 'POST',
        url: '/internal/webhooks/storage',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${WEBHOOK_SECRET}`,
        },
        // key encodes WH_TENANT but body claims a different (valid) tenant
        payload: {
          ...webhookPayload,
          tenantId: '99999999-9999-4999-8999-999999999999',
        },
      });
      expect(response.statusCode).toBe(200);
      expect(rpc).not.toHaveBeenCalled();
    });

    it('size over INT max → 422 (DTO @Max), RPC not called — avoids INT overflow 500/poison-retry', async () => {
      const rpc = jest.fn();
      mockCreateAdmin.mockReturnValue({ rpc });

      const response = await app.inject({
        method: 'POST',
        url: '/internal/webhooks/storage',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${WEBHOOK_SECRET}`,
        },
        payload: { ...webhookPayload, size: 2147483648 }, // PG INT max + 1
      });
      expect(response.statusCode).toBe(422);
      expect(rpc).not.toHaveBeenCalled();
    });

    it('size of 0 → 422 (DTO @Min(1)) — rejects empty/failed PUTs', async () => {
      const rpc = jest.fn();
      mockCreateAdmin.mockReturnValue({ rpc });

      const response = await app.inject({
        method: 'POST',
        url: '/internal/webhooks/storage',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${WEBHOOK_SECRET}`,
        },
        payload: { ...webhookPayload, size: 0 },
      });
      expect(response.statusCode).toBe(422);
      expect(rpc).not.toHaveBeenCalled();
    });
  });
});
