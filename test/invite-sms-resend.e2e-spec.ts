import { INestApplication, ValidationPipe } from '@nestjs/common';
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
import { accessToken, withPeople } from './helpers/auth-test-utils';
import { withOpenSubscription } from './helpers/open-subscription-admin';
import { SmsDeliveryProvider } from '../src/auth/sms-delivery.provider';

// Route wiring for POST /auth/invite/:membershipUserId/resend-sms (story 21-2):
// 401/403/404/409 plus the 201 happy path. Go-live (2026-11-17): the DLT
// template is approved and sending is on, so the 201 path runs the full send
// path — status guard, cap reserve and the (mocked) provider — and answers
// 'sent'. The cap limits live in invite-sms-resend-cap.e2e-spec.ts.

// The cap hash needs its key. Config only requires it in production, so the
// test supplies a throwaway value.
process.env['INVITE_SMS_HASH_KEY'] ??=
  'e2e-test-invite-sms-hash-key-0123456789';

const TENANT_ID = '33333333-3333-4333-8333-333333333333';
const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const TECH_ID = '22222222-2222-4222-8222-222222222222';
const VIEWER_ID = '77777777-7777-4777-8777-777777777777';
const MEMBER_ID = '88888888-8888-4888-8888-888888888888';
const UNKNOWN_ID = '99999999-9999-4999-8999-999999999999';

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

/** Fake of the membership read the resend makes, the status guard's re-read,
 *  the cap reserve and the audit insert. */
function makeAdmin(membership: unknown) {
  const maybeSingle = jest
    .fn()
    .mockResolvedValue({ data: membership, error: null });
  const select = jest.fn(() => ({
    eq: jest.fn(() => ({ eq: jest.fn(() => ({ maybeSingle })) })),
  }));
  const auditInsert = jest.fn().mockResolvedValue({ error: null });
  const rpc = jest.fn((name: string) => {
    if (name === 'invite_sms_reserve_send') {
      return Promise.resolve({ data: 'counter-1', error: null });
    }
    throw new Error(`unexpected rpc ${name}`);
  });
  const from = jest.fn((table: string) => {
    if (table === 'memberships') return { select };
    if (table === 'invite_sms_audit') return { insert: auditInsert };
    throw new Error(`unexpected table ${table}`);
  });
  return { admin: { from, rpc }, rpc, auditInsert };
}

describe('POST /api/v1/auth/invite/:membershipUserId/resend-sms (e2e)', () => {
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
      [
        { userId: OWNER_ID, tenantId: TENANT_ID, role: Role.COMPANY_ADMIN },
        { userId: TECH_ID, tenantId: TENANT_ID, role: Role.EMPLOYEE },
        { userId: VIEWER_ID, tenantId: TENANT_ID, role: Role.VIEWER },
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

  const url = (id: string) => `/api/v1/auth/invite/${id}/resend-sms`;

  function resend(id: string, token?: string) {
    return app.inject({
      method: 'POST',
      url: url(id),
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  }

  it('answers 401 with no token', async () => {
    const response = await resend(MEMBER_ID);
    expect(response.statusCode).toBe(401);
  });

  it.each([
    ['an employee', TECH_ID],
    ['a viewer', VIEWER_ID],
  ])('answers 403 NOT_COMPANY_ADMIN for %s', async (_label, userId) => {
    const response = await resend(MEMBER_ID, accessToken(jwtService, userId));
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).error_code).toBe('NOT_COMPANY_ADMIN');
  });

  it('answers 400 for a membership ID that is not a UUID', async () => {
    mockCreateAdmin.mockReturnValue(makeAdmin(INVITED_ROW).admin);
    const response = await resend(
      'not-a-uuid',
      accessToken(jwtService, OWNER_ID),
    );
    expect(response.statusCode).toBe(400);
  });

  it('answers 404 INVITE_NOT_FOUND for an unknown membership', async () => {
    mockCreateAdmin.mockReturnValue(makeAdmin(null).admin);
    const response = await resend(
      UNKNOWN_ID,
      accessToken(jwtService, OWNER_ID),
    );
    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body).error_code).toBe('INVITE_NOT_FOUND');
  });

  it('answers 409 INVITE_NOT_PENDING for a membership that already joined', async () => {
    mockCreateAdmin.mockReturnValue(
      makeAdmin({ ...INVITED_ROW, status: 'active' }).admin,
    );
    const response = await resend(MEMBER_ID, accessToken(jwtService, OWNER_ID));
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error_code).toBe('INVITE_NOT_PENDING');
  });

  it('answers 201 sent with only sms_status, and no phone number', async () => {
    const { admin, auditInsert } = makeAdmin(INVITED_ROW);
    mockCreateAdmin.mockReturnValue(admin);
    const response = await resend(MEMBER_ID, accessToken(jwtService, OWNER_ID));
    expect(response.statusCode).toBe(201);
    // Sending is on (go-live 2026-11-17): the resend answers 'sent' and the
    // mocked provider received exactly one send.
    expect(JSON.parse(response.body)).toEqual({ sms_status: 'sent' });
    expect(response.body).not.toContain('9876543210');
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(auditInsert.mock.calls[0][0].outcome).toBe('sent');
  });
});
