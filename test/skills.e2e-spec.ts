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

describe('Skills (e2e)', () => {
  let app: NestFastifyApplication;
  let jwtService: JwtService;
  let mockCreate: jest.Mock;
  let mockCreateAdmin: jest.Mock;

  const TENANT_ID = 'tenant-uuid-skills-e2e';
  const OWNER_ID = 'owner-uuid-skills-e2e';

  beforeAll(async () => {
    mockCreate = jest.fn();
    mockCreateAdmin = jest.fn();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SupabaseClientFactory)
      .useValue({ create: mockCreate, createAdmin: mockCreateAdmin })
      .compile();

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

  describe('tenant skills CRUD removed (Story 4.2)', () => {
    it('POST /api/v1/skills is gone (404)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/skills',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { name: 'AC Technician' },
      });

      expect(response.statusCode).toBe(404);
    });

    it('DELETE /api/v1/skills/:id is gone (404)', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: '/api/v1/skills/00000000-0000-0000-0000-000000000001',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('GET /api/v1/skills (global catalog)', () => {
    const catalogRows = [
      { id: 'skill-uuid-1', name: 'Plumbing' },
      { id: 'skill-uuid-2', name: 'Electrical' },
      { id: 'skill-uuid-3', name: 'AC Service' },
      { id: 'skill-uuid-4', name: 'AC Installation' },
      { id: 'skill-uuid-5', name: 'Pest Control' },
      { id: 'skill-uuid-6', name: 'Cleaning' },
    ];

    function mockJwtClient(rows: unknown[]) {
      const fromSpy = jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            order: jest.fn().mockResolvedValue({ data: rows, error: null }),
          }),
        }),
      });
      mockCreate.mockReturnValue({ from: fromSpy });
      return fromSpy;
    }

    it('should return 200 with the global catalog for an Owner JWT', async () => {
      const fromSpy = mockJwtClient(catalogRows);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/skills',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toEqual({ skills: catalogRows });
      expect(fromSpy).toHaveBeenCalledWith('skills');
    });

    it('should return 200 with the global catalog for a Technician JWT', async () => {
      mockJwtClient(catalogRows);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/skills',
        headers: { authorization: `Bearer ${techJwt()}` },
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ skills: catalogRows });
    });

    it('should return 200 with an empty list when the catalog has no rows', async () => {
      mockJwtClient([]);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/skills',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ skills: [] });
    });

    it('should return 401 with no JWT', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/skills',
      });

      expect(response.statusCode).toBe(401);
    });
  });
});
