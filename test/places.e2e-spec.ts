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
import {
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_SECONDS,
  RESOLVE_RATE_LIMIT_MAX,
  RESOLVE_RATE_LIMIT_WINDOW_SECONDS,
} from '../src/places/places.service';
import { SIMULATE_RESOLVE_ERROR_PLACE_ID } from '../src/places/mock-places.provider';

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

    // Backend-side mirror of the frontend's 3-character debounce gate — a
    // direct API caller must not be able to fire sub-3-char queries at the
    // (billable) live provider.
    it('should return 422 when q is shorter than 3 characters', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/places/autosuggest?q=ab&sessionToken=${SESSION_TOKEN}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(422);
    });

    it('should return 200 for exactly 3 characters (boundary)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/places/autosuggest?q=abc&sessionToken=${SESSION_TOKEN}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({
        suggestions: expect.any(Array),
      });
    });

    it('should return 422 when q is below 3 characters only after trimming', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/places/autosuggest?q=${encodeURIComponent('  a  ')}&sessionToken=${SESSION_TOKEN}`,
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
      expect(tripped.headers['retry-after']).toBe(
        String(RATE_LIMIT_WINDOW_SECONDS),
      );
    });
  });

  describe('GET /api/v1/places/resolve/:placeId', () => {
    const KNOWN_PLACE_ID = 'mock-place-andheri-west-1';
    const NULLABLE_PLACE_ID = 'mock-place-koramangala-sublocality-1';

    it('should return 200 with the resolved fixture for a valid Owner JWT (happy path, bound MockPlacesProvider)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/places/resolve/${KNOWN_PLACE_ID}?sessionToken=${SESSION_TOKEN}`,
        headers: {
          authorization: `Bearer ${ownerJwt('tenant-uuid-places-e2e-resolve-1')}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toMatchObject({
        placeId: KNOWN_PLACE_ID,
        formattedAddress: expect.any(String),
        city: expect.any(String),
        pincode: expect.any(String),
        latitude: expect.any(Number),
        longitude: expect.any(Number),
      });
    });

    it('should return 200 with city: null and pincode: null (never omitted/empty) for a place lacking them', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/places/resolve/${NULLABLE_PLACE_ID}?sessionToken=${SESSION_TOKEN}`,
        headers: {
          authorization: `Bearer ${ownerJwt('tenant-uuid-places-e2e-resolve-2')}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.city).toBeNull();
      expect(body.pincode).toBeNull();
      expect(typeof body.latitude).toBe('number');
      expect(typeof body.longitude).toBe('number');
    });

    it('should return 403 for Technician JWT', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/places/resolve/${KNOWN_PLACE_ID}?sessionToken=${SESSION_TOKEN}`,
        headers: { authorization: `Bearer ${techJwt()}` },
      });

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body).error_code).toBe('FORBIDDEN');
    });

    it('should return 401 with no JWT', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/places/resolve/${KNOWN_PLACE_ID}?sessionToken=${SESSION_TOKEN}`,
      });

      expect(response.statusCode).toBe(401);
    });

    it('should return 422 when sessionToken is missing', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/places/resolve/${KNOWN_PLACE_ID}`,
        headers: {
          authorization: `Bearer ${ownerJwt('tenant-uuid-places-e2e-resolve-422')}`,
        },
      });

      expect(response.statusCode).toBe(422);
    });

    it('should return 422 when sessionToken is empty/whitespace-only', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/places/resolve/${KNOWN_PLACE_ID}?sessionToken=${encodeURIComponent('   ')}`,
        headers: {
          authorization: `Bearer ${ownerJwt('tenant-uuid-places-e2e-resolve-422b')}`,
        },
      });

      expect(response.statusCode).toBe(422);
    });

    // Format gate (PlaceIdParamsDto) — malformed placeIds must be rejected
    // before any (billable) provider network call. A well-formed but unknown
    // placeId still takes the 502 path (tested below).
    it('should return 422 when placeId violates the format contract (too short)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/places/resolve/short-id?sessionToken=${SESSION_TOKEN}`,
        headers: {
          authorization: `Bearer ${ownerJwt('tenant-uuid-places-e2e-resolve-422c')}`,
        },
      });

      expect(response.statusCode).toBe(422);
    });

    it('should return 422 when placeId contains a character outside the contract', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/places/resolve/mock-place-inv!alid?sessionToken=${SESSION_TOKEN}`,
        headers: {
          authorization: `Bearer ${ownerJwt('tenant-uuid-places-e2e-resolve-422d')}`,
        },
      });

      expect(response.statusCode).toBe(422);
    });

    // Over-long placeIds are rejected even earlier than the DTO: Fastify's
    // own maxParamLength guard (default 100) fires at the routing layer with
    // 414, before the ValidationPipe. Still a pre-provider rejection — the
    // 422 contract below covers the shapes that do reach the DTO.
    it('should return 414 when placeId exceeds Fastify maxParamLength (over-long param)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/places/resolve/${'a'.repeat(256)}?sessionToken=${SESSION_TOKEN}`,
        headers: {
          authorization: `Bearer ${ownerJwt('tenant-uuid-places-e2e-resolve-422e')}`,
        },
      });

      expect(response.statusCode).toBe(414);
    });

    it('should return 502 PLACES_UPSTREAM_ERROR when the provider throws (sentinel placeId)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/places/resolve/${SIMULATE_RESOLVE_ERROR_PLACE_ID}?sessionToken=${SESSION_TOKEN}`,
        headers: {
          authorization: `Bearer ${ownerJwt('tenant-uuid-places-e2e-resolve-502')}`,
        },
      });

      expect(response.statusCode).toBe(502);
      expect(JSON.parse(response.body).error_code).toBe(
        'PLACES_UPSTREAM_ERROR',
      );
    });

    it('should return 502 PLACES_UPSTREAM_ERROR for an unrecognized placeId (no not-found path)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/places/resolve/mock-place-does-not-exist?sessionToken=${SESSION_TOKEN}`,
        headers: {
          authorization: `Bearer ${ownerJwt('tenant-uuid-places-e2e-resolve-unknown')}`,
        },
      });

      expect(response.statusCode).toBe(502);
      expect(JSON.parse(response.body).error_code).toBe(
        'PLACES_UPSTREAM_ERROR',
      );
    });

    // Drives the real, DI-bound PlacesRateLimitStore (backed by the actual
    // CACHE_MANAGER, not a mock) to its resolve-specific limit — independent
    // budget from autosuggest's (own tenant, own key suffix).
    it('should return 429 RATE_LIMITED once the real per-tenant resolve rate limiter is exceeded', async () => {
      const rateLimitJwt = ownerJwt('tenant-uuid-places-e2e-resolve-ratelimit');

      for (let i = 0; i < RESOLVE_RATE_LIMIT_MAX; i++) {
        const response = await app.inject({
          method: 'GET',
          url: `/api/v1/places/resolve/${KNOWN_PLACE_ID}?sessionToken=${SESSION_TOKEN}`,
          headers: { authorization: `Bearer ${rateLimitJwt}` },
        });
        expect(response.statusCode).toBe(200);
      }

      const tripped = await app.inject({
        method: 'GET',
        url: `/api/v1/places/resolve/${KNOWN_PLACE_ID}?sessionToken=${SESSION_TOKEN}`,
        headers: { authorization: `Bearer ${rateLimitJwt}` },
      });

      expect(tripped.statusCode).toBe(429);
      expect(JSON.parse(tripped.body).error_code).toBe('RATE_LIMITED');
      expect(tripped.headers['retry-after']).toBe(
        String(RESOLVE_RATE_LIMIT_WINDOW_SECONDS),
      );
    });
  });
});
