import { INestApplication, ValidationPipe } from '@nestjs/common';
import { VALIDATION_PIPE_OPTIONS } from '../src/common/validation-pipe-options';
import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module';
import { SupabaseClientFactory } from '../src/common/factories/supabase-client.factory';

const mockUser = {
  id: 'test-user-id-otp',
  country_code: '+91',
  phone_number: '9999999999',
  name: null,
  role: 'owner',
  tenant_id: null,
  status: 'active',
};

const mockSelectSingle = jest.fn();
const mockInsertSelectSingle = jest.fn();

const mockAdminClient = {
  from: jest.fn().mockImplementation((table: string) => {
    if (table === 'users') {
      return {
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({ single: mockSelectSingle }),
          }),
        }),
        insert: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnValue({ single: mockInsertSelectSingle }),
        }),
      };
    }
    return {};
  }),
};

describe('Auth Integration Tests (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SupabaseClientFactory)
      .useValue({
        create: jest.fn(),
        createAdmin: jest.fn().mockReturnValue(mockAdminClient),
      })
      .compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );

    // Match main.ts: health rides the prefix since a60fb30 (2026-09-21);
    // the old ['health'] exclusion made /api/v1/health 404 here.
    app.setGlobalPrefix('api/v1', { exclude: ['internal/webhooks/storage'] });
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /api/v1/auth/otp/send', () => {
    it('should send OTP for valid phone parts', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/send',
        payload: { countryCode: '+91', phoneNumber: '1234567890' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('otp_session_id');
      expect(body).toHaveProperty('expires_at');
      expect(body.otp_session_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });

    it('should reject missing + prefix on countryCode', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/send',
        payload: { countryCode: '91', phoneNumber: '1234567890' },
      });

      expect(response.statusCode).toBe(422);
      const body = JSON.parse(response.body);
      expect(body.error_code).toBe('VALIDATION_ERROR');
    });

    it('should reject non-digit phoneNumber', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/send',
        payload: { countryCode: '+91', phoneNumber: 'abc123' },
      });

      expect(response.statusCode).toBe(422);
      const body = JSON.parse(response.body);
      expect(body.error_code).toBe('VALIDATION_ERROR');
    });

    it('should enforce rate limit after 5 sends', async () => {
      for (let i = 0; i < 5; i++) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/otp/send',
          payload: { countryCode: '+91', phoneNumber: '9876543210' },
        });
        expect(response.statusCode).toBe(200);
      }

      const rateLimitResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/send',
        payload: { countryCode: '+91', phoneNumber: '9876543210' },
      });

      expect(rateLimitResponse.statusCode).toBe(429);
      const body = JSON.parse(rateLimitResponse.body);
      expect(body.error_code).toBe('RATE_LIMIT_EXCEEDED');
    });
  });

  describe('POST /api/v1/auth/otp/verify', () => {
    beforeEach(() => {
      mockSelectSingle.mockResolvedValue({
        data: null,
        error: { code: 'PGRST116' },
      });
      mockInsertSelectSingle.mockResolvedValue({ data: mockUser, error: null });
    });

    it('should verify OTP and return JWT for valid code', async () => {
      const sendResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/send',
        payload: { countryCode: '+91', phoneNumber: '9999999999' },
      });

      expect(sendResponse.statusCode).toBe(200);
      const sendBody = JSON.parse(sendResponse.body);
      const sessionId = sendBody.otp_session_id;
      // OTP_DEV_ECHO is on in the test env (jest.env.setup.ts) — the same
      // contract the app's __DEV__ chip consumes; the test reads the code
      // exactly like a dev client does.
      expect(sendBody.otp).toMatch(/^\d{6}$/);

      const verifyResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/verify',
        payload: { otpSessionId: sessionId, otpCode: sendBody.otp },
      });

      expect(verifyResponse.statusCode).toBe(200);
      const verifyBody = JSON.parse(verifyResponse.body);
      expect(verifyBody).toHaveProperty('token');
      expect(verifyBody.user).toMatchObject({
        userId: expect.any(String),
        tenantId: null,
        role: 'owner',
      });
      expect(verifyBody.token).toMatch(
        /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
      );
    });

    it('should reject a wrong code with 401 INVALID_OTP over HTTP', async () => {
      const sendResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/send',
        payload: { countryCode: '+91', phoneNumber: '8888888888' },
      });

      const sessionId = JSON.parse(sendResponse.body).otp_session_id;

      const verifyResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/verify',
        payload: { otpSessionId: sessionId, otpCode: '000000' },
      });

      // The Phase-1 accept-any-code behavior is gone (bug-bash 2026-10-02
      // F1): a wrong code is a 401 with the INVALID_OTP contract, and the
      // session survives for the lockout ladder.
      expect(verifyResponse.statusCode).toBe(401);
      expect(JSON.parse(verifyResponse.body).error_code).toBe('INVALID_OTP');
    });

    it('should lock the session after 5 wrong codes and refuse the correct one', async () => {
      const sendResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/send',
        payload: { countryCode: '+91', phoneNumber: '7777777777' },
      });
      const sendBody = JSON.parse(sendResponse.body);

      for (let attempt = 0; attempt < 5; attempt++) {
        const wrong = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/otp/verify',
          payload: { otpSessionId: sendBody.otp_session_id, otpCode: '000000' },
        });
        expect(wrong.statusCode).toBe(401);
        expect(JSON.parse(wrong.body).error_code).toBe('INVALID_OTP');
      }

      const locked = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/verify',
        payload: {
          otpSessionId: sendBody.otp_session_id,
          otpCode: sendBody.otp as string,
        },
      });
      expect(locked.statusCode).toBe(401);
      expect(JSON.parse(locked.body).error_code).toBe('OTP_SESSION_LOCKED');
    });

    it('should reject expired/non-existent session', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/verify',
        payload: {
          otpSessionId: '550e8400-e29b-41d4-a716-446655440099',
          otpCode: '123456',
        },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.error_code).toBe('OTP_EXPIRED');
    });

    it('should reject invalid OTP code format', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/verify',
        payload: {
          otpSessionId: '550e8400-e29b-41d4-a716-446655440000',
          otpCode: '12345', // Only 5 digits
        },
      });

      expect(response.statusCode).toBe(422);
      const body = JSON.parse(response.body);
      expect(body.error_code).toBe('VALIDATION_ERROR');
    });
  });

  describe('JWT authentication', () => {
    beforeEach(() => {
      mockSelectSingle.mockResolvedValue({
        data: null,
        error: { code: 'PGRST116' },
      });
      mockInsertSelectSingle.mockResolvedValue({ data: mockUser, error: null });
    });

    it('should allow protected route access with valid JWT', async () => {
      const sendResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/send',
        payload: { countryCode: '+91', phoneNumber: '6666666666' },
      });

      const sendBody = JSON.parse(sendResponse.body);

      const verifyResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/verify',
        payload: {
          otpSessionId: sendBody.otp_session_id,
          otpCode: sendBody.otp as string,
        },
      });

      const token = JSON.parse(verifyResponse.body).token;

      // A genuinely PROTECTED route — /health is @Public and would answer
      // 200 to any body, valid JWT or not (review VG-1).
      const realtimeResponse = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/realtime-token',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(realtimeResponse.statusCode).toBe(200);
      expect(JSON.parse(realtimeResponse.body)).toHaveProperty('token');
    });
  });
});
