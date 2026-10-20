import { INestApplication, ValidationPipe } from '@nestjs/common';
import { VALIDATION_PIPE_OPTIONS } from '../src/common/validation-pipe-options';
import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module';
import { SupabaseClientFactory } from '../src/common/factories/supabase-client.factory';
import {
  SmsDeliveryError,
  SmsDeliveryProvider,
} from '../src/auth/sms-delivery.provider';
import { OtpSessionStore } from '../src/auth/otp-session-store';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';

type Row = Record<string, unknown>;
type Result = {
  data: unknown;
  error: { code: string; message: string } | null;
};

// A small in-memory stand-in for the three tables login touches. `users`
// holds identity only; company and role live on `memberships`.
const db: Record<'users' | 'memberships' | 'tenants', Row[]> = {
  users: [],
  memberships: [],
  tenants: [],
};

/** Just enough of the Supabase query builder: select/insert/update + eq/neq. */
class FakeQuery implements PromiseLike<Result> {
  private mode: 'select' | 'insert' | 'update' = 'select';
  private columns = '';
  private patch: Row = {};
  private newRow: Row = {};
  private readonly filters: Array<(r: Row) => boolean> = [];

  constructor(private readonly table: keyof typeof db) {}

  select(columns = ''): this {
    this.columns = columns;
    return this;
  }
  insert(row: Row): this {
    this.mode = 'insert';
    this.newRow = row;
    return this;
  }
  update(patch: Row): this {
    this.mode = 'update';
    this.patch = patch;
    return this;
  }
  eq(col: string, val: unknown): this {
    this.filters.push((r) => r[col] === val);
    return this;
  }
  neq(col: string, val: unknown): this {
    this.filters.push((r) => r[col] !== val);
    return this;
  }
  maybeSingle(): Promise<Result> {
    return this.run().then((r) =>
      r.error ? r : { data: (r.data as Row[])[0] ?? null, error: null },
    );
  }
  single(): Promise<Result> {
    return this.run().then((r) => {
      if (r.error) return r;
      const row = (r.data as Row[])[0];
      return row
        ? { data: row, error: null }
        : { data: null, error: { code: 'PGRST116', message: 'no rows' } };
    });
  }
  then<T1 = Result, T2 = never>(
    ok?: ((v: Result) => T1 | PromiseLike<T1>) | null,
    fail?: ((e: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return this.run().then(ok, fail);
  }

  private run(): Promise<Result> {
    const rows = db[this.table];
    if (this.mode === 'insert') {
      const clash =
        this.table === 'users' &&
        rows.some(
          (u) =>
            u['country_code'] === this.newRow['country_code'] &&
            u['phone_number'] === this.newRow['phone_number'],
        );
      if (clash) {
        return Promise.resolve({
          data: null,
          error: { code: '23505', message: 'duplicate phone' },
        });
      }
      const row: Row =
        this.table === 'users'
          ? { platform_admin: false, disabled: false, ...this.newRow }
          : { ...this.newRow };
      rows.push(row);
      return Promise.resolve({ data: [row], error: null });
    }
    const hit = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.mode === 'update') {
      hit.forEach((r) => Object.assign(r, this.patch));
      return Promise.resolve({ data: hit, error: null });
    }
    // The access check embeds the person's memberships in the users read.
    const data = this.columns.includes('memberships:')
      ? hit.map((u) => ({
          ...u,
          memberships: db.memberships.filter((m) => m['user_id'] === u['id']),
        }))
      : hit;
    return Promise.resolve({ data, error: null });
  }
}

const mockAdminClient = {
  from: jest.fn((table: keyof typeof db) => new FakeQuery(table)),
};

const COMPANY = '11111111-1111-4111-8111-111111111111';
const seedUser = (phone: string, extra: Row = {}): Row => {
  const user: Row = {
    id: randomUUID(),
    country_code: '+91',
    phone_number: phone,
    name: null,
    platform_admin: false,
    disabled: false,
    ...extra,
  };
  db.users.push(user);
  return user;
};
const seedMembership = (userId: unknown, role: string, status: string) =>
  db.memberships.push({ user_id: userId, tenant_id: COMPANY, role, status });

describe('Auth Integration Tests (e2e)', () => {
  let app: NestFastifyApplication;

  beforeEach(() => {
    db.users.length = 0;
    db.memberships.length = 0;
    db.tenants.length = 0;
  });

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

  // The 502 contract (PRD FR-BE4) over real HTTP — the unit specs mock the
  // port at the service boundary; this boots the full app with a failing
  // gateway and asserts the GlobalExceptionFilter envelope AND the
  // outcome-specific session semantics through the public endpoints.
  describe('POST /api/v1/auth/otp/send — delivery failure (502 OTP_SEND_FAILED)', () => {
    let app: NestFastifyApplication;
    const failingSend = jest.fn();

    beforeAll(async () => {
      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(SupabaseClientFactory)
        .useValue({
          create: jest.fn(),
          createAdmin: jest.fn().mockReturnValue(mockAdminClient),
        })
        .overrideProvider(SmsDeliveryProvider)
        .useValue({ send: failingSend })
        .compile();

      app = moduleFixture.createNestApplication<NestFastifyApplication>(
        new FastifyAdapter(),
      );
      app.setGlobalPrefix('api/v1', { exclude: ['internal/webhooks/storage'] });
      app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
    });

    afterAll(async () => {
      await app.close();
    });

    // The 502 body carries no session id (by design), so the id is captured
    // from a pass-through spy on the store's set() and the deletion/retention
    // is proven over the verify endpoint — exactly what a real client can
    // observe.
    async function sendAndCaptureSession(phone: string): Promise<{
      sendStatus: number;
      sendBody: { error_code?: string };
      sessionId: string;
    }> {
      const store = app.get(OtpSessionStore);
      const setSpy = jest.spyOn(store, 'set');
      const sendResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/send',
        payload: { countryCode: '+91', phoneNumber: phone },
      });
      const sessionId = String(setSpy.mock.calls[0]?.[0] ?? '');
      setSpy.mockRestore();
      expect(sessionId).not.toBe('');
      return {
        sendStatus: sendResponse.statusCode,
        sendBody: JSON.parse(sendResponse.body),
        sessionId,
      };
    }

    it('a definitive gateway failure answers 502 OTP_SEND_FAILED and the session is gone (verify answers OTP_EXPIRED)', async () => {
      failingSend.mockRejectedValueOnce(
        new SmsDeliveryError('MSG91 send rejected (HTTP 402)', 'error'),
      );

      const { sendStatus, sendBody, sessionId } =
        await sendAndCaptureSession('5550001111');

      // 404 is not part of this API's vocabulary — 502 marks the upstream
      // gateway as the failing party, retryable.
      expect(sendStatus).toBe(502);
      expect(sendBody.error_code).toBe('OTP_SEND_FAILED');

      const verifyResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/verify',
        payload: { otpSessionId: sessionId, otpCode: '0000' },
      });
      expect(verifyResponse.statusCode).toBe(401);
      expect(JSON.parse(verifyResponse.body).error_code).toBe('OTP_EXPIRED');
    });

    it('a gateway TIMEOUT answers 502 but KEEPS the session (verify with the master code succeeds)', async () => {
      failingSend.mockRejectedValueOnce(
        new SmsDeliveryError('MSG91 send timed out after 4000ms', 'timeout'),
      );
      const { sendStatus, sessionId } =
        await sendAndCaptureSession('5550002222');

      expect(sendStatus).toBe(502);

      // OTP_DEV_ECHO is on in the test env, so the flag-gated master code
      // verifies any live session — proof the timeout did NOT delete it.
      const verifyResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/verify',
        payload: { otpSessionId: sessionId, otpCode: '1039' },
      });
      expect(verifyResponse.statusCode).toBe(200);
      expect(JSON.parse(verifyResponse.body)).toHaveProperty('token');
    });
  });

  describe('POST /api/v1/auth/otp/verify', () => {
    it('should verify OTP and return JWT for valid code', async () => {
      const sendResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/send',
        payload: { countryCode: '+91', phoneNumber: '9999999999' },
      });

      expect(sendResponse.statusCode).toBe(200);
      const sendBody = JSON.parse(sendResponse.body);
      const sessionId = sendBody.otp_session_id;
      // The response never carries the code (the dev echo is gone) — the
      // flag-gated master code is the testing channel.
      expect(sendBody).not.toHaveProperty('otp');

      const verifyResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/verify',
        payload: { otpSessionId: sessionId, otpCode: '1039' },
      });

      expect(verifyResponse.statusCode).toBe(200);
      const verifyBody = JSON.parse(verifyResponse.body);
      expect(verifyBody).toHaveProperty('token');
      // A brand-new person has no company yet: no tenant, no role.
      expect(verifyBody.user).toMatchObject({
        userId: expect.any(String),
        tenantId: null,
        role: null,
        platformAdmin: false,
      });
      expect(verifyBody.token).toMatch(
        /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
      );
      // The token is identity only; company and role never ride in it.
      const claims = app.get(JwtService).decode(verifyBody.token);
      expect(claims).toMatchObject({
        sub: verifyBody.user.userId,
        typ: 'access',
      });
      expect(claims).not.toHaveProperty('role');
      expect(claims).not.toHaveProperty('tenantId');
    });

    /** Send an OTP for a phone and verify it with the master code. */
    async function login(phone: string) {
      const send = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/send',
        payload: { countryCode: '+91', phoneNumber: phone },
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/verify',
        payload: {
          otpSessionId: JSON.parse(send.body).otp_session_id,
          otpCode: '1039',
        },
      });
      return { status: res.statusCode, body: JSON.parse(res.body) };
    }

    it('first sign-in activates an invited membership and returns its company and role', async () => {
      const user = seedUser('4440000001');
      seedMembership(user['id'], 'employee', 'invited');

      const { status, body } = await login('4440000001');

      expect(status).toBe(200);
      expect(body.user).toMatchObject({
        userId: user['id'],
        tenantId: COMPANY,
        role: 'employee',
      });
      expect(db.memberships[0]['status']).toBe('active');
    });

    it('an active company admin signs in without any change to the membership', async () => {
      const user = seedUser('4440000002', { name: 'Asha' });
      seedMembership(user['id'], 'company_admin', 'active');

      const { status, body } = await login('4440000002');

      expect(status).toBe(200);
      expect(body.user).toMatchObject({
        tenantId: COMPANY,
        role: 'company_admin',
        name: 'Asha',
      });
      expect(db.memberships).toHaveLength(1);
      expect(db.memberships[0]['status']).toBe('active');
    });

    it('a person whose only membership was removed gets no company and no role, and it stays removed', async () => {
      const user = seedUser('4440000003');
      seedMembership(user['id'], 'employee', 'removed');

      const { status, body } = await login('4440000003');

      expect(status).toBe(200);
      expect(body.user).toMatchObject({ tenantId: null, role: null });
      expect(db.memberships[0]['status']).toBe('removed');
    });

    it('a platform admin signs in as platform_admin with no company', async () => {
      seedUser('4440000004', { platform_admin: true });

      const { status, body } = await login('4440000004');

      expect(status).toBe(200);
      expect(body.user).toMatchObject({
        tenantId: null,
        role: 'platform_admin',
        platformAdmin: true,
      });
    });

    it('a disabled person is refused with the generic 401 INVALID_OTP and nothing is activated', async () => {
      const user = seedUser('4440000005', { disabled: true });
      seedMembership(user['id'], 'employee', 'invited');

      const { status, body } = await login('4440000005');

      expect(status).toBe(401);
      expect(body.error_code).toBe('INVALID_OTP');
      expect(body).not.toHaveProperty('token');
      expect(db.memberships[0]['status']).toBe('invited');
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
        payload: { otpSessionId: sessionId, otpCode: '0000' },
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
          payload: { otpSessionId: sendBody.otp_session_id, otpCode: '0000' },
        });
        expect(wrong.statusCode).toBe(401);
        expect(JSON.parse(wrong.body).error_code).toBe('INVALID_OTP');
      }

      const locked = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/verify',
        payload: {
          otpSessionId: sendBody.otp_session_id,
          otpCode: '1039', // flag-gated master — the echo is gone
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
          otpCode: '1234',
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
          otpCode: '1039', // flag-gated master — the echo is gone
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

    it('refuses an old-style token that carries tenantId and role instead of the access marker', async () => {
      const user = seedUser('4440000006');
      seedMembership(user['id'], 'company_admin', 'active');
      const oldToken = app
        .get(JwtService)
        .sign({ sub: user['id'], tenantId: COMPANY, role: 'owner' });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/realtime-token',
        headers: { authorization: `Bearer ${oldToken}` },
      });

      expect(response.statusCode).toBe(401);
    });

    it('refuses a valid access token once the person is disabled', async () => {
      const user = seedUser('4440000007');
      const token = app
        .get(JwtService)
        .sign({ sub: user['id'], typ: 'access' });
      user['disabled'] = true;

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/realtime-token',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(401);
    });
  });
});
