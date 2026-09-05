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
import { RATE_LIMIT_MAX } from '../src/places/places.service';

describe('Places (e2e)', () => {
  let app: NestFastifyApplication;
  let jwtService: JwtService;
  let mockCreateAdmin: jest.Mock;

  const TENANT_ID = 'tenant-uuid-places-e2e';
  const OWNER_ID = 'owner-uuid-places-e2e';
  const SESSION_TOKEN = 'a1b2c3d4-0000-4000-8000-000000000001';

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

  describe('GET /api/v1/places/autosuggest', () => {
    it('should return 200 with fixture suggestions for a valid Owner JWT (happy path, bound MockPlacesProvider)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/places/autosuggest?q=${encodeURIComponent('andheri w')}&sessionToken=${SESSION_TOKEN}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(Array.isArray(body.suggestions)).toBe(true);
      expect(body.suggestions.length).toBeGreaterThan(0);
      expect(body.suggestions[0]).toMatchObject({
        placeId: expect.any(String),
        text: expect.any(String),
      });
    });

    it('should return 200 with an empty suggestions array when the query matches no fixture', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/places/autosuggest?q=${encodeURIComponent('no-such-place-xyz')}&sessionToken=${SESSION_TOKEN}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ suggestions: [] });
    });

    it('should return 403 for Technician JWT', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/places/autosuggest?q=andheri&sessionToken=${SESSION_TOKEN}`,
        headers: { authorization: `Bearer ${techJwt()}` },
      });

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body).error_code).toBe('FORBIDDEN');
    });

    it('should return 401 with no JWT', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/places/autosuggest?q=andheri&sessionToken=${SESSION_TOKEN}`,
      });

      expect(response.statusCode).toBe(401);
    });

    it('should return 422 when q is missing', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/places/autosuggest?sessionToken=${SESSION_TOKEN}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(422);
    });

    it('should return 422 when sessionToken is missing', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/places/autosuggest?q=andheri',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(422);
    });

    it('should return 422 when sessionToken is empty/whitespace-only', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/places/autosuggest?q=andheri&sessionToken=${encodeURIComponent('   ')}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(422);
    });

    // Drives the real, DI-bound PlacesRateLimitStore (backed by the actual
    // CACHE_MANAGER, not a mock) to its limit — catches a broken/unwired
    // limiter that a fully-mocked service spec would never detect. Uses its
    // own tenant so it doesn't inherit request counts from the other cases
    // above (mirrors test/auth.integration.spec.ts's OTP rate-limit test).
    it('should return 429 RATE_LIMITED once the real per-tenant rate limiter is exceeded', async () => {
      const rateLimitJwt = ownerJwt('tenant-uuid-places-e2e-ratelimit');

      for (let i = 0; i < RATE_LIMIT_MAX; i++) {
        const response = await app.inject({
          method: 'GET',
          url: `/api/v1/places/autosuggest?q=andheri&sessionToken=${SESSION_TOKEN}`,
          headers: { authorization: `Bearer ${rateLimitJwt}` },
        });
        expect(response.statusCode).toBe(200);
      }

      const tripped = await app.inject({
        method: 'GET',
        url: `/api/v1/places/autosuggest?q=andheri&sessionToken=${SESSION_TOKEN}`,
        headers: { authorization: `Bearer ${rateLimitJwt}` },
      });

      expect(tripped.statusCode).toBe(429);
      expect(JSON.parse(tripped.body).error_code).toBe('RATE_LIMITED');
    });
  });
});
