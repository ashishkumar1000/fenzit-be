import { ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { JwtService } from '@nestjs/jwt';
import { AppModule } from '../src/app.module';
import { SupabaseClientFactory } from '../src/common/factories/supabase-client.factory';
import { VALIDATION_PIPE_OPTIONS } from '../src/common/validation-pipe-options';
import { Role } from '../src/common/enums/role.enum';
import {
  SmsDeliveryError,
  SmsDeliveryProvider,
} from '../src/auth/sms-delivery.provider';
import { accessToken, withPeople } from './helpers/auth-test-utils';
import { withOpenSubscription } from './helpers/open-subscription-admin';

// Story 21-2 over HTTP with a real template value, so sending is on: the 201
// 'sent' and 'failed' paths, and the 429 when the per-phone cap is reached.
// The template is swapped in with jest.mock, as the service unit spec does.
// The cap window itself is enforced by the database function and needs the
// real-database integration suite.

// The cap hash needs its key. Config only requires it in production, so the
// test supplies a throwaway value. Without it every send reads as failed.
process.env['INVITE_SMS_HASH_KEY'] ??=
  'e2e-test-invite-sms-hash-key-0123456789';

jest.mock('../src/common/constants/sms-templates', () => {
  const actual = jest.requireActual<
    typeof import('../src/common/constants/sms-templates')
  >('../src/common/constants/sms-templates');
  return {
    ...actual,
    SMS_TEMPLATES: { ...actual.SMS_TEMPLATES, 'T-INVITE': 'DLT-TEST-ID' },
  };
});

const TENANT_ID = '33333333-3333-4333-8333-333333333333';
const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const MEMBER_ID = '88888888-8888-4888-8888-888888888888';

const INVITED_ROW = {
  user_id: MEMBER_ID,
  role: 'employee',
  status: 'invited',
  users: {
    name: 'Ravi Kumar',
    country_code: '+91',
    phone_number: '9876543210',
  },
};

/**
 * Fake admin client. `reserve` is what invite_sms_reserve_send returns: a
 * counter id (slot taken) or null (cap reached).
 */
function makeAdmin(
  reserve: string | null,
  opts: { idempotencyHit?: unknown } = {},
) {
  const maybeSingle = jest
    .fn()
    .mockResolvedValue({ data: INVITED_ROW, error: null });
  const select = jest.fn(() => ({
    eq: jest.fn(() => ({ eq: jest.fn(() => ({ maybeSingle })) })),
  }));
  const auditInsert = jest.fn().mockResolvedValue({ error: null });
  const rpc = jest.fn().mockResolvedValue({ data: reserve, error: null });
  const counterDelete = jest.fn(() => ({
    eq: jest.fn().mockResolvedValue({ error: null }),
  }));
  // The idempotency lookup: select().eq().eq().eq().gt().maybeSingle().
  const idemHit = jest.fn().mockResolvedValue({
    data:
      opts.idempotencyHit === undefined
        ? null
        : { response_body: opts.idempotencyHit },
    error: null,
  });
  const idemSelect = jest.fn(() => ({
    eq: jest.fn(() => ({
      eq: jest.fn(() => ({
        eq: jest.fn(() => ({ gt: jest.fn(() => ({ maybeSingle: idemHit })) })),
      })),
    })),
  }));
  const idemInsert = jest.fn().mockResolvedValue({ error: null });
  const from = jest.fn((table: string) => {
    if (table === 'memberships') return { select };
    if (table === 'invite_sms_audit') return { insert: auditInsert };
    if (table === 'invite_sms_counter') return { delete: counterDelete };
    if (table === 'idempotency_log')
      return { select: idemSelect, insert: idemInsert };
    throw new Error(`unexpected table ${table}`);
  });
  return {
    admin: { from, rpc },
    rpc,
    auditInsert,
    counterDelete,
    idemInsert,
  };
}

describe('POST /api/v1/auth/invite/:membershipUserId/resend-sms, sending on (e2e)', () => {
  let app: NestFastifyApplication;
  let jwtService: JwtService;
  let mockCreateAdmin: jest.Mock;
  let mockSend: jest.Mock;

  beforeAll(async () => {
    mockCreateAdmin = jest.fn();
    mockSend = jest.fn().mockResolvedValue(undefined);
    const moduleFixture: TestingModule = await withPeople(
      Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(SupabaseClientFactory)
        .useValue({
          create: jest.fn(),
          createAdmin: () => withOpenSubscription(mockCreateAdmin()),
        })
        .overrideProvider(SmsDeliveryProvider)
        .useValue({ send: (...args: unknown[]) => mockSend(...args) }),
      [{ userId: OWNER_ID, tenantId: TENANT_ID, role: Role.COMPANY_ADMIN }],
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

  beforeEach(() => {
    mockSend.mockReset().mockResolvedValue(undefined);
  });

  function resend(extraHeaders: Record<string, string> = {}) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/auth/invite/${MEMBER_ID}/resend-sms`,
      headers: {
        authorization: `Bearer ${accessToken(jwtService, OWNER_ID)}`,
        ...extraHeaders,
      },
    });
  }

  it('answers 201 sent, reserves one cap slot with the 5-per-60-minute limit, and sends once', async () => {
    const { admin, rpc, auditInsert } = makeAdmin('counter-1');
    mockCreateAdmin.mockReturnValue(admin);

    const response = await resend();

    expect(response.statusCode).toBe(201);
    expect(JSON.parse(response.body)).toEqual({ sms_status: 'sent' });
    expect(rpc).toHaveBeenCalledWith(
      'invite_sms_reserve_send',
      expect.objectContaining({ p_max: 5, p_window_minutes: 60 }),
    );
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(auditInsert.mock.calls[0][0].outcome).toBe('sent');
  });

  it('answers 201 failed when the provider rejects, and the body carries no phone number', async () => {
    mockSend.mockRejectedValue(new SmsDeliveryError('vendor said no', 'error'));
    const { admin, auditInsert, counterDelete } = makeAdmin('counter-2');
    mockCreateAdmin.mockReturnValue(admin);

    const response = await resend();

    expect(response.statusCode).toBe(201);
    expect(JSON.parse(response.body)).toEqual({ sms_status: 'failed' });
    expect(response.body).not.toContain('9876543210');
    expect(auditInsert.mock.calls[0][0].outcome).toBe('failed');
    // The reserved slot is released, so the failed send does not count.
    expect(counterDelete).toHaveBeenCalledTimes(1);
  });

  it('answers 429 INVITE_SMS_LIMIT_REACHED when the cap is reached, and sends nothing', async () => {
    const { admin, auditInsert } = makeAdmin(null);
    mockCreateAdmin.mockReturnValue(admin);

    const response = await resend();

    expect(response.statusCode).toBe(429);
    expect(JSON.parse(response.body).error_code).toBe(
      'INVITE_SMS_LIMIT_REACHED',
    );
    expect(mockSend).not.toHaveBeenCalled();
    expect(auditInsert.mock.calls[0][0].outcome).toBe('refused_cap');
  });

  it('replays the first answer for a repeated idempotency key, and sends nothing', async () => {
    const { admin, rpc } = makeAdmin('counter-3', {
      idempotencyHit: { sms_status: 'sent' },
    });
    mockCreateAdmin.mockReturnValue(admin);

    const response = await resend({
      'x-idempotency-key': '6f1c2a4e-9b3d-4c5e-8a7f-0d1e2f3a4b5c',
    });

    expect(response.statusCode).toBe(201);
    expect(JSON.parse(response.body)).toEqual({ sms_status: 'sent' });
    expect(rpc).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('refuses a malformed idempotency key with 422 before anything is sent', async () => {
    const { admin, rpc } = makeAdmin('counter-4');
    mockCreateAdmin.mockReturnValue(admin);

    const response = await resend({ 'x-idempotency-key': 'not-a-uuid' });

    expect(response.statusCode).toBe(422);
    expect(rpc).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('stores the answer under the idempotency key after a first send', async () => {
    const { admin, idemInsert } = makeAdmin('counter-5');
    mockCreateAdmin.mockReturnValue(admin);

    const response = await resend({
      'x-idempotency-key': '0b9e8d7c-6a5f-4e3d-8c2b-1a0f9e8d7c6b',
    });

    expect(response.statusCode).toBe(201);
    // The interceptor saves the body after the handler returns. The save is
    // fire-and-forget, so give it one tick.
    await new Promise(resolve => setImmediate(resolve));
    expect(idemInsert).toHaveBeenCalledWith(
      expect.objectContaining({ response_body: { sms_status: 'sent' } }),
    );
  });
});
