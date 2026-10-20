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
import { Role } from '../src/common/enums/role.enum';
import { accessToken, withPeople } from './helpers/auth-test-utils';

// Real-looking ids: the guard refuses a token whose `sub` is not a UUID.
const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const TECH_ID = '22222222-2222-4222-8222-222222222222';
const TENANT_ID = '33333333-3333-4333-8333-333333333333';

describe('Company Onboarding (e2e)', () => {
  let app: NestFastifyApplication;
  let jwtService: JwtService;
  let mockRpc: jest.Mock;

  const JWT_SECRET = 'test-jwt-secret-for-e2e-tests-minimum-32-chars';

  const rpcRow = {
    id: TENANT_ID,
    created_by: OWNER_ID,
    company_name: 'E2E Corp',
    gstin: null,
    address: null,
    state_code: 'KA',
    upi_vpa: null,
    created_at: '2026-06-20T00:00:00Z',
    updated_at: '2026-06-20T00:00:00Z',
  };

  beforeAll(async () => {
    mockRpc = jest.fn();

    // The owner has no company yet (they are setting one up); the employee
    // belongs to another company.
    const moduleFixture: TestingModule = await withPeople(
      Test.createTestingModule({
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
        }),
      [
        { userId: OWNER_ID, tenantId: null, role: null },
        { userId: TECH_ID, tenantId: TENANT_ID, role: Role.EMPLOYEE },
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

  function ownerJwt(userId = OWNER_ID) {
    return accessToken(jwtService, userId);
  }

  function techJwt(userId = TECH_ID) {
    return accessToken(jwtService, userId);
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
        id: TENANT_ID,
        createdBy: OWNER_ID,
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

    it('should return 403 for an employee token (AC5)', async () => {
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
