import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { JwtService } from '@nestjs/jwt';
import { AppModule } from '../src/app.module';
import { SupabaseClientFactory } from '../src/common/factories/supabase-client.factory';

describe('Company Onboarding (e2e)', () => {
  let app: NestFastifyApplication;
  let jwtService: JwtService;
  let mockRpc: jest.Mock;

  const JWT_SECRET = 'test-jwt-secret-for-e2e-tests-minimum-32-chars';

  const rpcRow = {
    id: 'tenant-uuid-e2e',
    owner_id: 'owner-uuid-e2e',
    company_name: 'E2E Corp',
    gstin: null,
    address: null,
    state_code: 'KA',
    service_categories: [],
    upi_vpa: null,
    created_at: '2026-06-20T00:00:00Z',
    updated_at: '2026-06-20T00:00:00Z',
  };

  beforeAll(async () => {
    mockRpc = jest.fn();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SupabaseClientFactory)
      .useValue({
        create: jest.fn(),
        createAdmin: jest.fn().mockReturnValue({
          rpc: mockRpc,
          from: jest.fn().mockReturnValue({
            upsert: jest.fn().mockResolvedValue({ error: null }),
          }),
        }),
      })
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

  function ownerJwt(userId = 'owner-uuid-e2e', tenantId: string | null = null) {
    return jwtService.sign({ sub: userId, tenantId, role: 'owner' });
  }

  function techJwt(userId = 'tech-uuid-e2e') {
    return jwtService.sign({
      sub: userId,
      tenantId: 'some-tenant',
      role: 'technician',
    });
  }

  describe('POST /api/v1/auth/company', () => {
    it('should return 201 on first company creation (inserted=true)', async () => {
      mockRpc.mockResolvedValue({
        data: [{ ...rpcRow, inserted: true }],
        error: null,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/company',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { companyName: 'E2E Corp', stateCode: 'KA' },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.token).toBeDefined();
      expect(body.tenant).toMatchObject({
        id: 'tenant-uuid-e2e',
        companyName: 'E2E Corp',
        stateCode: 'KA',
      });
      expect(body.tenant).not.toHaveProperty('inserted');
    });

    it('should return 200 on idempotent re-call (inserted=false)', async () => {
      mockRpc.mockResolvedValue({
        data: [{ ...rpcRow, inserted: false }],
        error: null,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/company',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { companyName: 'E2E Corp Updated', stateCode: 'MH' },
      });

      expect(response.statusCode).toBe(200);
    });

    it('should return 403 for a Technician JWT (AC5)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/company',
        headers: { authorization: `Bearer ${techJwt()}` },
        payload: { companyName: 'Hack Corp', stateCode: 'KA' },
      });

      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body);
      expect(body.error_code).toBe('FORBIDDEN');
    });

    it('should return 422 for invalid GSTIN (AC3)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/company',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { companyName: 'ACME', stateCode: 'KA', gstin: 'INVALID' },
      });

      expect(response.statusCode).toBe(422);
      const body = JSON.parse(response.body);
      expect(body.error_code).toBe('VALIDATION_ERROR');
    });

    it('should return 422 when stateCode is missing (AC4)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/company',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { companyName: 'ACME' },
      });

      expect(response.statusCode).toBe(422);
      const body = JSON.parse(response.body);
      expect(body.error_code).toBe('VALIDATION_ERROR');
    });

    it('should return 401 when no JWT provided', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/company',
        payload: { companyName: 'ACME', stateCode: 'KA' },
      });

      expect(response.statusCode).toBe(401);
    });

    it('should accept valid GSTIN format', async () => {
      mockRpc.mockResolvedValue({
        data: [{ ...rpcRow, gstin: '29ABCDE1234F1Z5', inserted: true }],
        error: null,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/company',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: {
          companyName: 'ACME',
          stateCode: 'KA',
          gstin: '29ABCDE1234F1Z5',
        },
      });

      expect(response.statusCode).toBe(201);
    });

    it('should accept lowercase-free stateCode — reject lowercase', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/company',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { companyName: 'ACME', stateCode: 'ka' },
      });

      expect(response.statusCode).toBe(422);
    });
  });
});
