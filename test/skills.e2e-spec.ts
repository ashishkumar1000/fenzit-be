import { INestApplication, ValidationPipe } from '@nestjs/common';
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
  let mockCreateAdmin: jest.Mock;

  const TENANT_ID = 'tenant-uuid-skills-e2e';
  const OWNER_ID = 'owner-uuid-skills-e2e';

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

  const skill = {
    id: 'skill-uuid-1',
    name: 'AC Technician',
    tenant_id: TENANT_ID,
    created_at: '2026-06-20T00:00:00Z',
  };

  describe('POST /api/v1/skills', () => {
    it('AC1 — should return 201 with skill object on success', async () => {
      mockCreateAdmin.mockReturnValue({
        from: jest.fn().mockReturnValue({
          insert: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({ data: skill, error: null }),
            }),
          }),
        }),
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/skills',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { name: 'AC Technician' },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.id).toBe('skill-uuid-1');
      expect(body.name).toBe('AC Technician');
    });

    it('AC2 — should return 409 on duplicate skill name', async () => {
      mockCreateAdmin.mockReturnValue({
        from: jest.fn().mockReturnValue({
          insert: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({
                data: null,
                error: { code: '23505', message: 'unique constraint' },
              }),
            }),
          }),
        }),
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/skills',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { name: 'AC Technician' },
      });

      expect(response.statusCode).toBe(409);
      expect(JSON.parse(response.body).error_code).toBe('DUPLICATE_RESOURCE');
    });

    it('AC7 — should return 403 for Technician JWT', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/skills',
        headers: { authorization: `Bearer ${techJwt()}` },
        payload: { name: 'AC Technician' },
      });

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body).error_code).toBe('FORBIDDEN');
    });

    it('AC9 — should return 400 when owner has no tenantId', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/skills',
        headers: { authorization: `Bearer ${ownerJwt(null)}` },
        payload: { name: 'AC Technician' },
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('should return 422 for empty name', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/skills',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { name: '' },
      });

      expect(response.statusCode).toBe(422);
    });

    it('should return 401 with no JWT', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/skills',
        payload: { name: 'AC Technician' },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /api/v1/skills', () => {
    it('AC3 — should return 200 with array of skills', async () => {
      mockCreateAdmin.mockReturnValue({
        from: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              order: jest.fn().mockResolvedValue({
                data: [skill],
                error: null,
              }),
            }),
          }),
        }),
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/skills',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(Array.isArray(body)).toBe(true);
      expect(body[0].name).toBe('AC Technician');
    });

    it('AC3 — should return empty array when no skills', async () => {
      mockCreateAdmin.mockReturnValue({
        from: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              order: jest.fn().mockResolvedValue({ data: [], error: null }),
            }),
          }),
        }),
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/skills',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual([]);
    });

    it('AC9 — should return 400 when owner has no tenantId', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/skills',
        headers: { authorization: `Bearer ${ownerJwt(null)}` },
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('AC7 — should return 403 for Technician JWT', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/skills',
        headers: { authorization: `Bearer ${techJwt()}` },
      });

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body).error_code).toBe('FORBIDDEN');
    });
  });

  describe('DELETE /api/v1/skills/:id', () => {
    it('AC4 — should return 200 on successful delete', async () => {
      let fromCallCount = 0;
      mockCreateAdmin.mockReturnValue({
        from: jest.fn().mockImplementation(() => {
          fromCallCount++;
          if (fromCallCount === 1) {
            return {
              select: jest.fn().mockReturnValue({
                eq: jest.fn().mockReturnValue({
                  eq: jest.fn().mockReturnValue({
                    single: jest.fn().mockResolvedValue({
                      data: { id: '00000000-0000-0000-0000-000000000001' },
                      error: null,
                    }),
                  }),
                }),
              }),
            };
          }
          return {
            delete: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                eq: jest.fn().mockResolvedValue({ error: null }),
              }),
            }),
          };
        }),
      });

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/v1/skills/00000000-0000-0000-0000-000000000001',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ success: true });
    });

    it('AC6 — should return 404 when skill not in tenant', async () => {
      mockCreateAdmin.mockReturnValue({
        from: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                single: jest.fn().mockResolvedValue({
                  data: null,
                  error: { code: 'PGRST116' },
                }),
              }),
            }),
          }),
        }),
      });

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/v1/skills/00000000-0000-0000-0000-000000000099',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.body).error_code).toBe('RESOURCE_NOT_FOUND');
    });

    it('AC7 — should return 403 for Technician JWT', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: '/api/v1/skills/00000000-0000-0000-0000-000000000001',
        headers: { authorization: `Bearer ${techJwt()}` },
      });

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body).error_code).toBe('FORBIDDEN');
    });

    it('AC9 — should return 400 when owner has no tenantId', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: '/api/v1/skills/00000000-0000-0000-0000-000000000001',
        headers: { authorization: `Bearer ${ownerJwt(null)}` },
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error_code).toBe('VALIDATION_ERROR');
    });
  });
});
