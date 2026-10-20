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

describe('Member Invitation (e2e)', () => {
  let app: NestFastifyApplication;
  let jwtService: JwtService;
  let mockCreateAdmin: jest.Mock;

  const TENANT_ID = '33333333-3333-4333-8333-333333333333';
  const OWNER_ID = '11111111-1111-4111-8111-111111111111';
  const TECH_ID = '22222222-2222-4222-8222-222222222222';
  const VIEWER_ID = '77777777-7777-4777-8777-777777777777';
  const NEW_USER_ID = '88888888-8888-4888-8888-888888888888';
  const SKILL_ID = '550e8400-e29b-41d4-a716-446655440001';

  beforeAll(async () => {
    mockCreateAdmin = jest.fn();

    const moduleFixture: TestingModule = await withPeople(
      Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(SupabaseClientFactory)
        .useValue({
          create: jest.fn(),
          createAdmin: mockCreateAdmin,
        }),
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

  function ownerJwt(userId = OWNER_ID) {
    return accessToken(jwtService, userId);
  }

  function techJwt() {
    return accessToken(jwtService, TECH_ID);
  }

  function viewerJwt() {
    return accessToken(jwtService, VIEWER_ID);
  }

  /** Builds a Supabase admin mock for the invite endpoint's two database calls:
   *  1. from('skills').select().in().eq()  — global skills-catalog check
   *  2. rpc('invite_member', ...)          — the one all-or-nothing invite step
   *     (finds or creates the person, refuses someone already in a company,
   *     creates the membership, attaches skills, writes the audit row)
   */
  function makeInviteMock(opts: {
    validSkills?: { id: string }[];
    rpcData?: unknown;
    rpcError?: { code?: string; message?: string; hint?: string } | null;
  }) {
    const validSkillsData =
      opts.validSkills !== undefined ? opts.validSkills : [{ id: SKILL_ID }];
    const rpc = jest.fn().mockResolvedValue({
      data: opts.rpcData ?? null,
      error: opts.rpcError ?? null,
    });
    return {
      rpc,
      from: jest.fn().mockImplementation(() => ({
        select: jest.fn().mockReturnValue({
          in: jest.fn().mockReturnValue({
            eq: jest
              .fn()
              .mockResolvedValue({ data: validSkillsData, error: null }),
          }),
        }),
      })),
    };
  }

  const inviteRow = [
    { member_user_id: NEW_USER_ID, member_employee_code: 'EMP-002' },
  ];

  describe('POST /api/v1/auth/invite', () => {
    it('AC1 — should return 201 with invite_id on successful invite', async () => {
      const admin = makeInviteMock({ rpcData: inviteRow });
      mockCreateAdmin.mockReturnValue(admin);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/invite',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: {
          countryCode: '+91',
          phoneNumber: '1111111111',
          name: 'Ravi Kumar',
          skillIds: [SKILL_ID],
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body).toEqual({ invite_id: NEW_USER_ID, employee_code: 'EMP-002' });
      // The company comes from the caller's membership, never the request.
      expect(admin.rpc).toHaveBeenCalledWith('invite_member', {
        p_caller: OWNER_ID,
        p_tenant_id: TENANT_ID,
        p_country_code: '+91',
        p_phone_number: '1111111111',
        p_name: 'Ravi Kumar',
        p_role: 'employee',
        p_skill_ids: [SKILL_ID],
      });
    });

    it('AC2 — should return 409 when phone is already active in tenant', async () => {
      mockCreateAdmin.mockReturnValue(
        makeInviteMock({
          // The database function refuses a person who already belongs to a
          // company with PT409.
          rpcError: { code: 'PT409', message: 'already a member' },
        }),
      );

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/invite',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: {
          countryCode: '+91',
          phoneNumber: '1111111111',
          name: 'Ravi Kumar',
          skillIds: [SKILL_ID],
        },
      });

      expect(response.statusCode).toBe(409);
      const body = JSON.parse(response.body);
      expect(body.error_code).toBe('DUPLICATE_RESOURCE');
    });

    it('AC2 — should return 409 on duplicate phone unique constraint (23505)', async () => {
      mockCreateAdmin.mockReturnValue(
        makeInviteMock({
          rpcError: {
            code: '23505',
            message: 'duplicate key value violates unique constraint',
          },
        }),
      );

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/invite',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: {
          countryCode: '+91',
          phoneNumber: '1111111111',
          name: 'Ravi Kumar',
          skillIds: [SKILL_ID],
        },
      });

      expect(response.statusCode).toBe(409);
      const body = JSON.parse(response.body);
      expect(body.error_code).toBe('DUPLICATE_RESOURCE');
    });

    it('AC3 — should return 422 when skillIds is an empty array', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/invite',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: {
          countryCode: '+91',
          phoneNumber: '1111111111',
          name: 'Ravi Kumar',
          skillIds: [],
        },
      });

      expect(response.statusCode).toBe(422);
      const body = JSON.parse(response.body);
      expect(body.error_code).toBe('VALIDATION_ERROR');
    });

    it('AC4 — should return 422 when skillIds contains a non-UUID string', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/invite',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: {
          countryCode: '+91',
          phoneNumber: '1111111111',
          name: 'Ravi Kumar',
          skillIds: ['not-a-uuid'],
        },
      });

      expect(response.statusCode).toBe(422);
      const body = JSON.parse(response.body);
      expect(body.error_code).toBe('VALIDATION_ERROR');
    });

    it('AC5 — should return 400 when skillIds contain unknown UUIDs (not in the global catalog)', async () => {
      mockCreateAdmin.mockReturnValue(makeInviteMock({ validSkills: [] }));

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/invite',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: {
          countryCode: '+91',
          phoneNumber: '1111111111',
          name: 'Ravi Kumar',
          skillIds: ['550e8400-e29b-41d4-a716-446655440099'],
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error_code).toBe('VALIDATION_ERROR');
    });

    it('AC6 — should return 403 for an employee token', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/invite',
        headers: { authorization: `Bearer ${techJwt()}` },
        payload: {
          countryCode: '+91',
          phoneNumber: '1111111111',
          name: 'Ravi Kumar',
          skillIds: [SKILL_ID],
        },
      });

      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body);
      expect(body.error_code).toBe('FORBIDDEN');
    });

    it('AC6 — should return 403 for a viewer token (no member.invite)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/invite',
        headers: { authorization: `Bearer ${viewerJwt()}` },
        payload: {
          countryCode: '+91',
          phoneNumber: '1111111111',
          name: 'Ravi Kumar',
          skillIds: [SKILL_ID],
        },
      });

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body).error_code).toBe('FORBIDDEN');
    });

    it('should return 403 when the database refuses the caller (PT403)', async () => {
      mockCreateAdmin.mockReturnValue(
        makeInviteMock({ rpcError: { code: 'PT403', message: 'not admin' } }),
      );

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/invite',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: {
          countryCode: '+91',
          phoneNumber: '1111111111',
          name: 'Ravi Kumar',
          skillIds: [SKILL_ID],
        },
      });

      expect(response.statusCode).toBe(403);
    });

    it('should return 422 for invalid countryCode format', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/invite',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: {
          countryCode: '91',
          phoneNumber: '1111111111',
          name: 'Ravi Kumar',
          skillIds: [SKILL_ID],
        },
      });

      expect(response.statusCode).toBe(422);
      const body = JSON.parse(response.body);
      expect(body.error_code).toBe('VALIDATION_ERROR');
    });

    it('should return 401 when no JWT provided', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/invite',
        payload: {
          countryCode: '+91',
          phoneNumber: '1111111111',
          name: 'Ravi Kumar',
          skillIds: [SKILL_ID],
        },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('POST /api/v1/auth/otp/verify — auto-accept flow (AC3)', () => {
    const INVITED_USER_ID = '99999999-9999-4999-8999-999999999999';
    const invitedUser = {
      id: INVITED_USER_ID,
      country_code: '+91',
      phone_number: '2222222222',
      name: 'Ravi Kumar',
      platform_admin: false,
      disabled: false,
    };
    const invitedMembership = {
      tenant_id: TENANT_ID,
      role: 'employee',
      status: 'invited',
    };

    /** Table-keyed mock of the four reads/writes a first sign-in makes. */
    function makeAutoAcceptMock() {
      const membershipUpdate = jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          eq: jest.fn().mockResolvedValue({ error: null }),
        }),
      });
      const from = jest.fn().mockImplementation((table: string) => {
        if (table === 'memberships') {
          return {
            // live-membership read: select().eq().neq().maybeSingle()
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                neq: jest.fn().mockReturnValue({
                  maybeSingle: jest
                    .fn()
                    .mockResolvedValue({ data: invitedMembership, error: null }),
                }),
              }),
            }),
            update: membershipUpdate,
          };
        }
        // users: the phone lookup (eq, eq, maybeSingle) and the
        // platform-admin check (eq, maybeSingle).
        const chain: Record<string, jest.Mock> = {};
        chain.eq = jest.fn().mockReturnValue(chain);
        chain.maybeSingle = jest.fn().mockImplementation(() =>
          Promise.resolve({
            data: chain.eq.mock.calls.length > 1 ? invitedUser : { platform_admin: false },
            error: null,
          }),
        );
        return { select: jest.fn().mockReturnValue(chain) };
      });
      return { from, membershipUpdate };
    }

    it('AC3 — invited user OTP verify activates the invite and returns an identity-only JWT', async () => {
      const admin = makeAutoAcceptMock();
      mockCreateAdmin.mockReturnValue(admin);

      const sendResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/send',
        payload: { countryCode: '+91', phoneNumber: '2222222222' },
      });
      expect(sendResponse.statusCode).toBe(200);
      const sendBody = JSON.parse(sendResponse.body);
      // The response never carries the code (the dev echo is gone) — the
      // flag-gated master code is the testing channel.
      expect(sendBody).not.toHaveProperty('otp');

      const verifyResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/verify',
        payload: { otpSessionId: sendBody.otp_session_id, otpCode: '1039' },
      });

      expect(verifyResponse.statusCode).toBe(200);
      const body = JSON.parse(verifyResponse.body);
      expect(body.token).toBeDefined();
      expect(body.user.tenantId).toBe(TENANT_ID);
      expect(body.user.role).toBe('employee');
      // The invited membership became active.
      expect(admin.membershipUpdate).toHaveBeenCalledWith({ status: 'active' });
      // The token says who the person is and nothing else; company and role
      // are read from the database on every request.
      const claims = jwtService.decode(body.token);
      expect(claims).toMatchObject({ sub: INVITED_USER_ID, typ: 'access' });
      expect(claims).not.toHaveProperty('tenantId');
      expect(claims).not.toHaveProperty('role');
    });
  });
});
