import { INestApplication, ValidationPipe } from '@nestjs/common';
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
  skill_type: null,
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
      const sessionId = JSON.parse(sendResponse.body).otp_session_id;

      const verifyResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/verify',
        payload: { otpSessionId: sessionId, otpCode: '123456' },
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

    it('should accept any 6-digit code in mock mode (Phase 1 behavior)', async () => {
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

      expect(verifyResponse.statusCode).toBe(200);
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
        payload: { otpSessionId: sendBody.otp_session_id, otpCode: '123456' },
      });

      const token = JSON.parse(verifyResponse.body).token;

      const healthResponse = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(healthResponse.statusCode).toBe(200);
    });
  });
});
