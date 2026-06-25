import { ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { JwtService } from '@nestjs/jwt';
import { AppModule } from '../src/app.module';
import { SupabaseClientFactory } from '../src/common/factories/supabase-client.factory';

describe('Customers (e2e)', () => {
  let app: NestFastifyApplication;
  let jwtService: JwtService;
  let mockCreateAdmin: jest.Mock;

  const TENANT_ID = 'tenant-uuid-customers-e2e';
  const OWNER_ID = 'owner-uuid-customers-e2e';

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

    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
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

  const customerRow = {
    id: 'customer-uuid-1',
    name: 'Priya Sharma',
    country_code: '+91',
    phone_number: '9876543210',
    address: null,
    city: null,
    created_via: 'manual',
    created_at: '2026-06-21T00:00:00Z',
    tenant_id: TENANT_ID,
  };

  const validPayload = {
    name: 'Priya Sharma',
    countryCode: '+91',
    phoneNumber: '9876543210',
  };

  function mockInsertResult(result: { data: unknown; error: unknown }) {
    mockCreateAdmin.mockReturnValue({
      from: jest.fn().mockReturnValue({
        insert: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnValue({
            single: jest.fn().mockResolvedValue(result),
          }),
        }),
      }),
    });
  }

  describe('POST /api/v1/customers', () => {
    it('AC1 — should return 201 with the created customer', async () => {
      mockInsertResult({ data: customerRow, error: null });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/customers',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: validPayload,
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.id).toBe('customer-uuid-1');
      expect(body.name).toBe('Priya Sharma');
      expect(body.countryCode).toBe('+91');
      expect(body.phoneNumber).toBe('9876543210');
      expect(body.createdVia).toBe('manual');
      expect(body.tenantId).toBe(TENANT_ID);
    });

    it('AC2 — should return 409 on duplicate phone (23505)', async () => {
      mockInsertResult({
        data: null,
        error: { code: '23505', message: 'unique constraint' },
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/customers',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: validPayload,
      });

      expect(response.statusCode).toBe(409);
      expect(JSON.parse(response.body).error_code).toBe('DUPLICATE_RESOURCE');
    });

    it('AC3 — should return 422 for invalid phoneNumber', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/customers',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { name: 'Priya', countryCode: '+91', phoneNumber: 'abc' },
      });

      expect(response.statusCode).toBe(422);
      expect(JSON.parse(response.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('AC3 — should return 422 for invalid countryCode', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/customers',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: {
          name: 'Priya',
          countryCode: '91',
          phoneNumber: '9876543210',
        },
      });

      expect(response.statusCode).toBe(422);
      expect(JSON.parse(response.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('AC3 — should return 422 for whitespace-only name', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/customers',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { name: '   ', countryCode: '+91', phoneNumber: '9876543210' },
      });

      expect(response.statusCode).toBe(422);
      expect(JSON.parse(response.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('should return 400 (VALIDATION_ERROR) when countryCode passes regex but is not a known dial code (23503)', async () => {
      mockInsertResult({
        data: null,
        error: { code: '23503', message: 'foreign key violation' },
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/customers',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: {
          name: 'Priya',
          countryCode: '+99',
          phoneNumber: '9876543210',
        },
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('AC7 — should ignore client-supplied created_via, tenant_id, and id (whitelist strips them)', async () => {
      let capturedInsert: Record<string, unknown> | undefined;
      mockCreateAdmin.mockReturnValue({
        from: jest.fn().mockReturnValue({
          insert: jest
            .fn()
            .mockImplementation((row: Record<string, unknown>) => {
              capturedInsert = row;
              return {
                select: jest.fn().mockReturnValue({
                  single: jest
                    .fn()
                    .mockResolvedValue({ data: customerRow, error: null }),
                }),
              };
            }),
        }),
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/customers',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: {
          ...validPayload,
          created_via: 'job_creation',
          tenant_id: 'attacker-tenant',
          id: 'attacker-chosen-id',
        },
      });

      expect(response.statusCode).toBe(201);
      // The forbidden fields never reach the DB insert payload...
      expect(capturedInsert).toBeDefined();
      expect(capturedInsert).not.toHaveProperty('created_via');
      expect(capturedInsert!.tenant_id).toBe(TENANT_ID);
      expect(capturedInsert!.id).not.toBe('attacker-chosen-id');
      // ...and the response reflects server-controlled values only.
      const body = JSON.parse(response.body);
      expect(body.createdVia).toBe('manual');
      expect(body.tenantId).toBe(TENANT_ID);
    });

    it('AC4 — should return 403 for Technician JWT', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/customers',
        headers: { authorization: `Bearer ${techJwt()}` },
        payload: validPayload,
      });

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body).error_code).toBe('FORBIDDEN');
    });

    it('AC5 — should return 400 when owner has no tenantId', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/customers',
        headers: { authorization: `Bearer ${ownerJwt(null)}` },
        payload: validPayload,
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('AC6 — should return 401 with no JWT', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/customers',
        payload: validPayload,
      });

      expect(response.statusCode).toBe(401);
      expect(JSON.parse(response.body).error_code).toBe('UNAUTHORIZED');
    });
  });

  describe('GET /api/v1/customers', () => {
    const listRow = {
      id: 'cust-1',
      name: 'Priya Sharma',
      country_code: '+91',
      phone_number: '9876543210',
      city: 'Bengaluru',
      created_at: '2026-06-21T00:00:00Z',
    };

    // The GET builder is awaited at .limit() (no .single()). select/eq/or/order
    // return the builder; limit() resolves to { data, error }. Captures .or() args.
    function mockListResult(result: { data: unknown; error: unknown }) {
      const orArgs: string[] = [];
      const builder: Record<string, jest.Mock> = {};
      builder.select = jest.fn(() => builder);
      builder.eq = jest.fn(() => builder);
      builder.or = jest.fn((arg: string) => {
        orArgs.push(arg);
        return builder;
      });
      builder.order = jest.fn(() => builder);
      builder.limit = jest.fn().mockResolvedValue(result);
      mockCreateAdmin.mockReturnValue({ from: jest.fn(() => builder) });
      return { orArgs };
    }

    it('AC1 — should return 200 with a paginated list and item shape', async () => {
      mockListResult({ data: [listRow], error: null });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/customers',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.hasMore).toBe(false);
      expect(body.nextCursor).toBeNull();
      expect(body.data).toHaveLength(1);
      expect(body.data[0]).toEqual({
        id: 'cust-1',
        name: 'Priya Sharma',
        countryCode: '+91',
        phoneNumber: '9876543210',
        city: 'Bengaluru',
        jobCount: 0,
        lastJobDate: null,
      });
    });

    it('AC4 — should return 200 with empty data when no customers', async () => {
      mockListResult({ data: [], error: null });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/customers',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({
        data: [],
        nextCursor: null,
        hasMore: false,
      });
    });

    it('AC2/AC3 — should apply an ilike search .or() for ?q=', async () => {
      const { orArgs } = mockListResult({ data: [listRow], error: null });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/customers?q=priya',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(200);
      expect(orArgs).toContain('name.ilike.*priya*,phone_number.ilike.*priya*');
    });

    it('AC3 — should match on phone digits for a numeric ?q=', async () => {
      const { orArgs } = mockListResult({ data: [listRow], error: null });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/customers?q=9833',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(200);
      expect(orArgs).toContain('name.ilike.*9833*,phone_number.ilike.*9833*');
    });

    it('AC5 — should accept a cursor and return the next page', async () => {
      const cursorId = '00000000-0000-4000-8000-000000000001';
      const cursor = Buffer.from(
        JSON.stringify({ id: cursorId, createdAt: '2026-06-21T00:00:00Z' }),
      ).toString('base64url');
      const { orArgs } = mockListResult({ data: [listRow], error: null });

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/customers?cursor=${cursor}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(200);
      expect(orArgs).toContain(
        `created_at.lt.2026-06-21T00:00:00Z,and(created_at.eq.2026-06-21T00:00:00Z,id.lt.${cursorId})`,
      );
    });

    it('AC8 — should return 400 for a malformed cursor', async () => {
      mockListResult({ data: [], error: null });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/customers?cursor=not-valid',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('AC8 — should return 400 for a well-formed base64 cursor missing/invalid fields', async () => {
      mockListResult({ data: [], error: null });
      // valid base64url JSON, but id is not a UUID (also covers forged-injection payloads)
      const badCursor = Buffer.from(
        JSON.stringify({ id: 'x),or(tenant_id.neq.0', createdAt: 'nope' }),
      ).toString('base64url');

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/customers?cursor=${badCursor}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('AC6 — should return 403 for Technician JWT', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/customers',
        headers: { authorization: `Bearer ${techJwt()}` },
      });

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body).error_code).toBe('FORBIDDEN');
    });

    it('AC7 — should return 400 when owner has no tenantId', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/customers',
        headers: { authorization: `Bearer ${ownerJwt(null)}` },
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('AC9 — should return 401 with no JWT', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/customers',
      });

      expect(response.statusCode).toBe(401);
      expect(JSON.parse(response.body).error_code).toBe('UNAUTHORIZED');
    });
  });

  describe('GET /api/v1/customers/:id', () => {
    const CUSTOMER_ID = '00000000-0000-4000-8000-000000000001';
    const detailRow = {
      id: CUSTOMER_ID,
      name: 'Priya Sharma',
      country_code: '+91',
      phone_number: '9876543210',
      address: '12 MG Road',
      city: 'Bengaluru',
      created_via: 'manual',
      created_at: '2026-06-21T00:00:00Z',
      tenant_id: TENANT_ID,
    };

    // detail terminal is .single() after two .eq() calls (id, tenant_id)
    function mockDetail(result: { data: unknown; error: unknown }) {
      mockCreateAdmin.mockReturnValue({
        from: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                single: jest.fn().mockResolvedValue(result),
              }),
            }),
          }),
        }),
      });
    }

    it('AC1 — should return 200 with the full profile + empty jobHistory', async () => {
      mockDetail({ data: detailRow, error: null });

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/customers/${CUSTOMER_ID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.id).toBe(CUSTOMER_ID);
      expect(body.name).toBe('Priya Sharma');
      expect(body.countryCode).toBe('+91');
      expect(body.phoneNumber).toBe('9876543210');
      expect(body.createdVia).toBe('manual');
      expect(body.tenantId).toBe(TENANT_ID);
      expect(body.jobHistory).toEqual({
        data: [],
        nextCursor: null,
        hasMore: false,
      });
    });

    it('AC3 — should return 404 when the customer does not exist', async () => {
      mockDetail({ data: null, error: { code: 'PGRST116' } });

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/customers/${CUSTOMER_ID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.body).error_code).toBe('RESOURCE_NOT_FOUND');
    });

    it('AC2 — should return 404 (not 403) for a customer in another tenant', async () => {
      // tenant_id filter returns no rows → PGRST116, identical to not-found
      mockDetail({ data: null, error: { code: 'PGRST116' } });

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/customers/${CUSTOMER_ID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.body).error_code).toBe('RESOURCE_NOT_FOUND');
    });

    it('AC6 — should return 400 for a non-UUID id (ParseUUIDPipe)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/customers/not-a-uuid',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(400);
    });

    it('AC7 — should return 403 for Technician JWT', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/customers/${CUSTOMER_ID}`,
        headers: { authorization: `Bearer ${techJwt()}` },
      });

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body).error_code).toBe('FORBIDDEN');
    });

    it('AC6/AC7 — Technician + non-UUID id is 403 (RolesGuard runs before ParseUUIDPipe)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/customers/not-a-uuid',
        headers: { authorization: `Bearer ${techJwt()}` },
      });

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body).error_code).toBe('FORBIDDEN');
    });

    it('AC8 — should return 400 when owner has no tenantId', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/customers/${CUSTOMER_ID}`,
        headers: { authorization: `Bearer ${ownerJwt(null)}` },
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('AC9 — should return 401 with no JWT', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/customers/${CUSTOMER_ID}`,
      });

      expect(response.statusCode).toBe(401);
      expect(JSON.parse(response.body).error_code).toBe('UNAUTHORIZED');
    });
  });
});
