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
import { Role } from '../src/common/enums/role.enum';
import { accessToken, withPeople } from './helpers/auth-test-utils';

describe('Customers (e2e)', () => {
  let app: NestFastifyApplication;
  let jwtService: JwtService;
  let mockCreateAdmin: jest.Mock;

  const TENANT_ID = '33333333-3333-4333-8333-333333333333';
  const OWNER_ID = '11111111-1111-4111-8111-111111111111';
  const TECH_ID = '22222222-2222-4222-8222-222222222222';
  // A signed-in person who belongs to no company yet.
  const VIEWER_ID = '77777777-7777-4777-8777-777777777777';
  const NO_COMPANY_ID = '00000000-0000-4000-8000-000000000003';

  beforeAll(async () => {
    mockCreateAdmin = jest.fn();

    const moduleFixture: TestingModule = await withPeople(
      Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(SupabaseClientFactory)
        .useValue({ create: jest.fn(), createAdmin: mockCreateAdmin }),
      [
        { userId: OWNER_ID, tenantId: TENANT_ID, role: Role.COMPANY_ADMIN },
        { userId: TECH_ID, tenantId: TENANT_ID, role: Role.EMPLOYEE },
        { userId: VIEWER_ID, tenantId: TENANT_ID, role: Role.VIEWER },
        { userId: NO_COMPANY_ID, tenantId: null, role: null },
      ],
    ).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );

    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));

    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    jwtService = moduleFixture.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  function ownerJwt() {
    return accessToken(jwtService, OWNER_ID);
  }

  /** A signed-in person who belongs to no company yet. */
  function noCompanyJwt() {
    return accessToken(jwtService, NO_COMPANY_ID);
  }

  function techJwt() {
    return accessToken(jwtService, TECH_ID);
  }

  const customerRow = {
    id: 'customer-uuid-1',
    name: 'Priya Sharma',
    country_code: '+91',
    phone_number: '9876543210',
    address: null,
    city: null,
    formatted_address: null,
    pincode: null,
    latitude: null,
    longitude: null,
    place_id: null,
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

    it('Story 1.3 — should return 201 with all 5 structured-address fields persisted and reflected in the response', async () => {
      let capturedInsert: Record<string, unknown> | undefined;
      mockCreateAdmin.mockReturnValue({
        from: jest.fn().mockReturnValue({
          insert: jest
            .fn()
            .mockImplementation((row: Record<string, unknown>) => {
              capturedInsert = row;
              return {
                select: jest.fn().mockReturnValue({
                  single: jest.fn().mockResolvedValue({
                    data: {
                      ...customerRow,
                      formatted_address:
                        '12 MG Road, Bengaluru, Karnataka 560001, India',
                      pincode: '560001',
                      latitude: 12.9716,
                      longitude: 77.5946,
                      place_id: 'ChIJbU60yXAWrjsR4E9-UejD3_g',
                    },
                    error: null,
                  }),
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
          formattedAddress: '12 MG Road, Bengaluru, Karnataka 560001, India',
          pincode: '560001',
          latitude: 12.9716,
          longitude: 77.5946,
          placeId: 'ChIJbU60yXAWrjsR4E9-UejD3_g',
        },
      });

      expect(response.statusCode).toBe(201);
      expect(capturedInsert).toMatchObject({
        formatted_address: '12 MG Road, Bengaluru, Karnataka 560001, India',
        pincode: '560001',
        latitude: 12.9716,
        longitude: 77.5946,
        place_id: 'ChIJbU60yXAWrjsR4E9-UejD3_g',
      });
      const body = JSON.parse(response.body);
      expect(body.formattedAddress).toBe(
        '12 MG Road, Bengaluru, Karnataka 560001, India',
      );
      expect(body.pincode).toBe('560001');
      expect(body.latitude).toBe(12.9716);
      expect(body.longitude).toBe(77.5946);
      expect(body.placeId).toBe('ChIJbU60yXAWrjsR4E9-UejD3_g');
    });

    it('Story 1.3 — should return 201 with none of the 5 structured-address fields (legacy request, unchanged behavior)', async () => {
      mockInsertResult({ data: customerRow, error: null });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/customers',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: validPayload,
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.formattedAddress).toBeNull();
      expect(body.pincode).toBeNull();
      expect(body.latitude).toBeNull();
      expect(body.longitude).toBeNull();
      expect(body.placeId).toBeNull();
    });

    it('Story 1.3 — should return 422 when latitude/longitude are non-numeric', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/customers',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: {
          ...validPayload,
          latitude: 'not-a-number',
          longitude: 'not-a-number',
        },
      });

      expect(response.statusCode).toBe(422);
      expect(JSON.parse(response.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('Story 1.3 — should return 422 when latitude is out of range', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/customers',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: {
          ...validPayload,
          latitude: 999,
          longitude: 77.5946,
        },
      });

      expect(response.statusCode).toBe(422);
      expect(JSON.parse(response.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('Story 1.3 — should return 422 when longitude is out of range', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/customers',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: {
          ...validPayload,
          latitude: 12.9716,
          longitude: -999,
        },
      });

      expect(response.statusCode).toBe(422);
      expect(JSON.parse(response.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('Story 1.3 — should return 422 when pincode is not a valid 6-digit Indian PIN (non-numeric)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/customers',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: {
          ...validPayload,
          pincode: 'ABC123',
        },
      });

      expect(response.statusCode).toBe(422);
      expect(JSON.parse(response.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('Story 1.3 — should return 422 when pincode is only 5 digits', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/customers',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: {
          ...validPayload,
          pincode: '56001',
        },
      });

      expect(response.statusCode).toBe(422);
      expect(JSON.parse(response.body).error_code).toBe('VALIDATION_ERROR');
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

    it('AC4 — should return 403 for an employee token', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/customers',
        headers: { authorization: `Bearer ${techJwt()}` },
        payload: validPayload,
      });

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body).error_code).toBe('FORBIDDEN');
    });

    it('AC4 — should return 403 for a viewer token (read-only role)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/customers',
        headers: { authorization: `Bearer ${accessToken(jwtService, VIEWER_ID)}` },
        payload: validPayload,
      });

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body).error_code).toBe('FORBIDDEN');
    });

    it('AC5 — should return 403 for a person with no company', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/customers',
        headers: { authorization: `Bearer ${noCompanyJwt()}` },
        payload: validPayload,
      });

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body).error_code).toBe('FORBIDDEN');
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
      // List query terminal is .limit() — routed by table name (like
      // mockDetail) since listCustomers now queries both `customers` and
      // `jobs`, so a terminal-change regression in either query fails loudly
      // instead of silently consuming the other's rows.
      const customerBuilder: Record<string, jest.Mock> = {};
      customerBuilder.select = jest.fn(() => customerBuilder);
      customerBuilder.eq = jest.fn(() => customerBuilder);
      customerBuilder.or = jest.fn((arg: string) => {
        orArgs.push(arg);
        return customerBuilder;
      });
      customerBuilder.order = jest.fn(() => customerBuilder);
      customerBuilder.limit = jest.fn().mockResolvedValue(result);

      // getJobStats' jobs query awaits at .in(). Resolves with no job rows,
      // matching AC1's expected item shape (jobCount 0 / lastJobDate null).
      // Tests needing job stats should extend this mock.
      const jobsBuilder: Record<string, jest.Mock> = {};
      jobsBuilder.select = jest.fn(() => jobsBuilder);
      jobsBuilder.eq = jest.fn(() => jobsBuilder);
      jobsBuilder.in = jest.fn().mockResolvedValue({ data: [], error: null });

      mockCreateAdmin.mockReturnValue({
        from: jest.fn((table: string) =>
          table === 'jobs' ? jobsBuilder : customerBuilder,
        ),
      });
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
        JSON.stringify({
          id: cursorId,
          createdAt: '2026-06-21T00:00:00Z',
          scope: 'customers-list',
        }),
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

    it('AC6 — should return 403 for an employee token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/customers',
        headers: { authorization: `Bearer ${techJwt()}` },
      });

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body).error_code).toBe('FORBIDDEN');
    });

    it('AC7 — should return 403 for a person with no company', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/customers',
        headers: { authorization: `Bearer ${noCompanyJwt()}` },
      });

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body).error_code).toBe('FORBIDDEN');
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

    // Customer fetch terminal is .single() after two .eq() calls (id, tenant_id).
    // Job-history fetch terminal is .limit() — routed by table name since
    // getCustomerDetail now queries both `customers` and `jobs`.
    function mockDetail(
      customerResult: { data: unknown; error: unknown },
      jobHistoryResult: { data: unknown; error: unknown } = {
        data: [],
        error: null,
      },
    ) {
      const customerBuilder = {
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue(customerResult),
            }),
          }),
        }),
      };

      const orArgs: string[] = [];
      const jobsBuilder: Record<string, jest.Mock> = {};
      jobsBuilder.select = jest.fn(() => jobsBuilder);
      jobsBuilder.eq = jest.fn(() => jobsBuilder);
      jobsBuilder.or = jest.fn((arg: string) => {
        orArgs.push(arg);
        return jobsBuilder;
      });
      jobsBuilder.order = jest.fn(() => jobsBuilder);
      jobsBuilder.limit = jest.fn().mockResolvedValue(jobHistoryResult);

      mockCreateAdmin.mockReturnValue({
        from: jest.fn((table: string) =>
          table === 'jobs' ? jobsBuilder : customerBuilder,
        ),
      });
      return { jobsBuilder, orArgs };
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

    it('AC1/AC2 — should return real, paginated job history sorted scheduled_start DESC', async () => {
      const jobRow = {
        id: '00000000-0000-4000-8000-000000002001',
        job_number: 'JOB-1',
        scheduled_start: '2026-06-01T00:00:00Z',
        status: 'completed',
        // Story 4.5 — the FK embed the history select now reads.
        skills: { name: 'AC Service' },
      };
      mockDetail(
        { data: detailRow, error: null },
        { data: [jobRow], error: null },
      );

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/customers/${CUSTOMER_ID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.jobHistory).toEqual({
        data: [
          {
            id: jobRow.id,
            jobNumber: 'JOB-1',
            scheduledStart: '2026-06-01T00:00:00Z',
            status: 'completed',
            skillName: 'AC Service',
          },
        ],
        nextCursor: null,
        hasMore: false,
      });
    });

    it('AC3 — should return 400 for a malformed job-history cursor', async () => {
      mockDetail({ data: detailRow, error: null });

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/customers/${CUSTOMER_ID}?cursor=not-valid`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('AC3 — should return the second page when a valid nextCursor is passed back', async () => {
      // page 1: 21 rows → 20 returned + a 21st probe row
      const rows = Array.from({ length: 21 }, (_, i) => ({
        id: `00000000-0000-4000-8000-0000000040${String(i).padStart(2, '0')}`,
        job_number: `JOB-${i}`,
        scheduled_start: `2026-01-${(21 - i).toString().padStart(2, '0')}T00:00:00Z`,
        status: 'completed',
        // Story 4.5 — the FK embed the history select now reads.
        skills: { name: `Skill ${i}` },
      }));
      mockDetail({ data: detailRow, error: null }, { data: rows, error: null });

      const first = await app.inject({
        method: 'GET',
        url: `/api/v1/customers/${CUSTOMER_ID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(first.statusCode).toBe(200);
      const page1 = JSON.parse(first.body);
      expect(page1.jobHistory.data).toHaveLength(20);
      expect(page1.jobHistory.hasMore).toBe(true);
      expect(page1.jobHistory.nextCursor).not.toBeNull();

      // page 2: only the probe row is left past the cursor
      mockDetail(
        { data: detailRow, error: null },
        { data: [rows[20]], error: null },
      );

      const second = await app.inject({
        method: 'GET',
        url: `/api/v1/customers/${CUSTOMER_ID}?cursor=${page1.jobHistory.nextCursor}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(second.statusCode).toBe(200);
      const page2 = JSON.parse(second.body);
      expect(page2.jobHistory.data).toEqual([
        {
          id: rows[20].id,
          jobNumber: rows[20].job_number,
          scheduledStart: rows[20].scheduled_start,
          status: rows[20].status,
          skillName: 'Skill 20',
        },
      ]);
      expect(page2.jobHistory.hasMore).toBe(false);
      expect(page2.jobHistory.nextCursor).toBeNull();
    });

    it('AC3 — an empty cursor (?cursor=) behaves like no cursor (first page, 200)', async () => {
      const jobRow = {
        id: '00000000-0000-4000-8000-000000005001',
        job_number: 'JOB-9',
        scheduled_start: '2026-06-09T00:00:00Z',
        status: 'completed',
      };
      const { orArgs } = mockDetail(
        { data: detailRow, error: null },
        { data: [jobRow], error: null },
      );

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/customers/${CUSTOMER_ID}?cursor=`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).jobHistory.data).toHaveLength(1);
      expect(orArgs).toHaveLength(0);
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

    it('AC7 — should return 403 for an employee token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/customers/${CUSTOMER_ID}`,
        headers: { authorization: `Bearer ${techJwt()}` },
      });

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body).error_code).toBe('FORBIDDEN');
    });

    it('AC6/AC7 — an employee + non-UUID id is 403 (PermissionsGuard runs before ParseUUIDPipe)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/customers/not-a-uuid',
        headers: { authorization: `Bearer ${techJwt()}` },
      });

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body).error_code).toBe('FORBIDDEN');
    });

    it('AC8 — should return 403 for a person with no company', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/customers/${CUSTOMER_ID}`,
        headers: { authorization: `Bearer ${noCompanyJwt()}` },
      });

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body).error_code).toBe('FORBIDDEN');
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

  describe('PATCH /api/v1/customers/:id', () => {
    const PATCH_ID = '00000000-0000-4000-8000-000000000002';

    const patchedRow = {
      ...customerRow,
      id: PATCH_ID,
      name: 'Priya Reddy',
      address: '9 Church Street',
      city: 'Bengaluru',
      address_details: null,
    };

    // The PATCH builder is awaited at .select() after two .eq() calls (id,
    // tenant_id) — the guarded single-row UPDATE. Captures the patch payload
    // so tests can pin exactly which columns a given body writes.
    function mockUpdate(result: { data: unknown; error: unknown }) {
      let capturedPatch: Record<string, unknown> | undefined;
      const builder: Record<string, jest.Mock> = {};
      builder.update = jest.fn((patch: Record<string, unknown>) => {
        capturedPatch = patch;
        return builder;
      });
      builder.eq = jest.fn(() => builder);
      builder.select = jest.fn().mockResolvedValue(result);
      mockCreateAdmin.mockReturnValue({
        from: jest.fn().mockReturnValue(builder),
      });
      return { builder, patch: () => capturedPatch };
    }

    it('AC2/matrix-1 — should return 200 with the updated customer (camelCase, phone unchanged)', async () => {
      mockUpdate({ data: [patchedRow], error: null });

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/customers/${PATCH_ID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { name: 'Priya Reddy', address: '9 Church Street' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.id).toBe(PATCH_ID);
      expect(body.name).toBe('Priya Reddy');
      expect(body.address).toBe('9 Church Street');
      expect(body.countryCode).toBe('+91');
      expect(body.phoneNumber).toBe('9876543210');
    });

    it('CAP-4 — the guarded UPDATE filters by id AND tenant_id', async () => {
      const { builder } = mockUpdate({ data: [patchedRow], error: null });

      await app.inject({
        method: 'PATCH',
        url: `/api/v1/customers/${PATCH_ID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { name: 'Priya Reddy' },
      });

      expect(builder.update).toHaveBeenCalled();
      expect(builder.eq).toHaveBeenCalledWith('id', PATCH_ID);
      expect(builder.eq).toHaveBeenCalledWith('tenant_id', TENANT_ID);
    });

    it('matrix-2/CAP-2/3 — a location pick writes the location block and never touches addressDetails (CAP-5)', async () => {
      const row = {
        ...patchedRow,
        formatted_address: '9 Church Street, Bengaluru, Karnataka 560001, India',
        pincode: '560001',
        latitude: 12.9716,
        longitude: 77.5946,
        place_id: 'ChIJbU60yXAWrjsR4E9-UejD3_g',
      };
      const { patch } = mockUpdate({ data: [row], error: null });

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/customers/${PATCH_ID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: {
          formattedAddress: '9 Church Street, Bengaluru, Karnataka 560001, India',
          pincode: '560001',
          latitude: 12.9716,
          longitude: 77.5946,
          placeId: 'ChIJbU60yXAWrjsR4E9-UejD3_g',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(patch()).toEqual({
        formatted_address: '9 Church Street, Bengaluru, Karnataka 560001, India',
        pincode: '560001',
        latitude: 12.9716,
        longitude: 77.5946,
        place_id: 'ChIJbU60yXAWrjsR4E9-UejD3_g',
      });
      const body = JSON.parse(response.body);
      expect(body.pincode).toBe('560001');
      expect(body.latitude).toBe(12.9716);
      expect(body.placeId).toBe('ChIJbU60yXAWrjsR4E9-UejD3_g');
    });

    it('patch semantics — present-with-null clears, absent keys stay out of the patch', async () => {
      const { patch } = mockUpdate({
        data: [{ ...patchedRow, address: null }],
        error: null,
      });

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/customers/${PATCH_ID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { address: null, city: 'Bengaluru' },
      });

      expect(response.statusCode).toBe(200);
      expect(patch()).toEqual({ address: null, city: 'Bengaluru' });
      expect(JSON.parse(response.body).address).toBeNull();
    });

    it('patch semantics — a trimmed-empty string clears the column (manual clear)', async () => {
      const { patch } = mockUpdate({
        data: [{ ...patchedRow, address: null }],
        error: null,
      });

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/customers/${PATCH_ID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { address: '   ' },
      });

      expect(response.statusCode).toBe(200);
      expect(patch()).toEqual({ address: null });
      expect(JSON.parse(response.body).address).toBeNull();
    });

    it('CAP-5 — an explicit null clears addressDetails', async () => {
      const { patch } = mockUpdate({ data: [patchedRow], error: null });

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/customers/${PATCH_ID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { addressDetails: null },
      });

      expect(response.statusCode).toBe(200);
      expect(patch()).toEqual({ address_details: null });
    });

    it('matrix-3 — Manual-entry clear: the whole location block nulls in one body, addressDetails untouched', async () => {
      const { patch } = mockUpdate({ data: [patchedRow], error: null });

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/customers/${PATCH_ID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: {
          latitude: null,
          longitude: null,
          formattedAddress: null,
          pincode: null,
          placeId: null,
        },
      });

      expect(response.statusCode).toBe(200);
      // The patch carries exactly the five nulled keys — `address_details`
      // stays absent, so the column is untouched (CAP-5).
      expect(patch()).toEqual({
        latitude: null,
        longitude: null,
        formatted_address: null,
        pincode: null,
        place_id: null,
      });
    });

    it('matrix-9 — phone keys stripped silently alongside a mutable key (200, phone unchanged)', async () => {
      const { patch } = mockUpdate({ data: [patchedRow], error: null });

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/customers/${PATCH_ID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: {
          name: 'Priya Reddy',
          phoneNumber: '9999999999',
          countryCode: '+1',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(patch()).toEqual({ name: 'Priya Reddy' });
      expect(JSON.parse(response.body).phoneNumber).toBe('9876543210');
    });

    it('whitelist — unknown keys are stripped silently, never rejected or written', async () => {
      const { patch } = mockUpdate({ data: [patchedRow], error: null });

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/customers/${PATCH_ID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: {
          name: 'Priya Reddy',
          tenantId: 'attacker-tenant',
          createdVia: 'job_creation',
          id: 'attacker-chosen-id',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(patch()).toEqual({ name: 'Priya Reddy' });
    });

    it('AC5/matrix-9 — a body with ONLY stripped keys (lone phone) is 400 "Nothing to update"', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/customers/${PATCH_ID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { phoneNumber: '9999999999' },
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).message).toBe('Nothing to update');
    });

    it('should return 422 for a whitespace-only name', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/customers/${PATCH_ID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { name: '   ' },
      });

      expect(response.statusCode).toBe(422);
      expect(JSON.parse(response.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('should return 422 for a name longer than 120 chars', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/customers/${PATCH_ID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { name: 'x'.repeat(121) },
      });

      expect(response.statusCode).toBe(422);
      expect(JSON.parse(response.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('should return 422 for a malformed pincode', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/customers/${PATCH_ID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { pincode: 'abc123' },
      });

      expect(response.statusCode).toBe(422);
      expect(JSON.parse(response.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('AC6/matrix-8 — should return 422 for an out-of-range latitude (same class as create)', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/customers/${PATCH_ID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { latitude: 999, longitude: 77.5946 },
      });

      expect(response.statusCode).toBe(422);
      expect(JSON.parse(response.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('AC5/matrix-4 — should return 400 "Nothing to update" for an empty body', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/customers/${PATCH_ID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error_code).toBe('VALIDATION_ERROR');
      expect(body.message).toBe('Nothing to update');
    });

    it('AC5 — should return 400 when the body carries only a null name (it can never clear)', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/customers/${PATCH_ID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { name: null },
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).message).toBe('Nothing to update');
    });

    it('should return 400 for a non-UUID id (ParseUUIDPipe)', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/v1/customers/not-a-uuid',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { name: 'Priya Reddy' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('AC4/matrix-6 — should return 404 when the guarded UPDATE matches no row (unknown or foreign-tenant id)', async () => {
      mockUpdate({ data: [], error: null });

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/customers/${PATCH_ID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { name: 'Priya Reddy' },
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.error_code).toBe('RESOURCE_NOT_FOUND');
      expect(body.message).toBe('Customer not found');
    });

    it('should return 500 when the DB update errors', async () => {
      mockUpdate({
        data: null,
        error: { code: 'XX000', message: 'boom' },
      });

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/customers/${PATCH_ID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { name: 'Priya Reddy' },
      });

      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body).error_code).toBe(
        'INTERNAL_SERVER_ERROR',
      );
    });

    it('AC3/matrix-5 — should return 403 for an employee token', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/customers/${PATCH_ID}`,
        headers: { authorization: `Bearer ${techJwt()}` },
        payload: { name: 'Priya Reddy' },
      });

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body).error_code).toBe('FORBIDDEN');
    });

    it('guard-order — an employee + non-UUID id is 403 (PermissionsGuard runs before ParseUUIDPipe)', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/v1/customers/not-a-uuid',
        headers: { authorization: `Bearer ${techJwt()}` },
        payload: { name: 'Priya Reddy' },
      });

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body).error_code).toBe('FORBIDDEN');
    });

    it('matrix-7 — should return 403 for a person with no company', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/customers/${PATCH_ID}`,
        headers: { authorization: `Bearer ${noCompanyJwt()}` },
        payload: { name: 'Priya Reddy' },
      });

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body).error_code).toBe('FORBIDDEN');
    });

    it('should return 401 with no JWT', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/customers/${PATCH_ID}`,
        payload: { name: 'Priya Reddy' },
      });

      expect(response.statusCode).toBe(401);
      expect(JSON.parse(response.body).error_code).toBe('UNAUTHORIZED');
    });
  });
});
