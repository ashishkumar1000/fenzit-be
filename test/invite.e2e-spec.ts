import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { JwtService } from '@nestjs/jwt';
import { AppModule } from '../src/app.module';
import { SupabaseClientFactory } from '../src/common/factories/supabase-client.factory';

describe('Technician Invitation (e2e)', () => {
  let app: NestFastifyApplication;
  let jwtService: JwtService;
  let mockCreateAdmin: jest.Mock;

  const TENANT_ID = 'tenant-uuid-invite-e2e';
  const OWNER_ID = 'owner-uuid-invite-e2e';
  const SKILL_ID = '550e8400-e29b-41d4-a716-446655440001';

  beforeAll(async () => {
    mockCreateAdmin = jest.fn();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SupabaseClientFactory)
      .useValue({
        create: jest.fn(),
        createAdmin: mockCreateAdmin,
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

    jwtService = moduleFixture.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  function ownerJwt(userId = OWNER_ID, tenantId: string | null = TENANT_ID) {
    return jwtService.sign({ sub: userId, tenantId, role: 'owner' });
  }

  function techJwt() {
    return jwtService.sign({
      sub: 'tech-uuid-e2e',
      tenantId: TENANT_ID,
      role: 'technician',
    });
  }

  /** Builds a Supabase admin mock for the invite endpoint's four DB calls:
   *  1. select().eq().eq().eq().eq().maybeSingle()  — active-member check
   *  2. select().in().eq()                          — skill ownership check
   *  3. insert().select().single()                  — new user insert
   *  4. insert()                                    — user_skills insert
   */
  function makeInviteMock(opts: {
    activeMember?: { id: string; status: string } | null;
    validSkills?: { id: string }[];
    insertData?: { id: string } | null;
    insertError?: { code?: string; message?: string } | null;
    userSkillsError?: { code?: string; message?: string } | null;
  }) {
    const maybeSingleFn = jest.fn().mockResolvedValue({
      data: opts.activeMember ?? null,
      error: null,
    });
    const insertSingleFn = jest.fn().mockResolvedValue({
      data: opts.insertData ?? null,
      error: opts.insertError ?? null,
    });
    const validSkillsData =
      opts.validSkills !== undefined ? opts.validSkills : [{ id: SKILL_ID }];

    let fromCallCount = 0;
    return {
      from: jest.fn().mockImplementation(() => {
        fromCallCount++;
        if (fromCallCount === 1) {
          // active-member check
          return {
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                eq: jest.fn().mockReturnValue({
                  eq: jest.fn().mockReturnValue({
                    eq: jest.fn().mockReturnValue({
                      maybeSingle: maybeSingleFn,
                    }),
                  }),
                }),
              }),
            }),
          };
        } else if (fromCallCount === 2) {
          // skill ownership check
          return {
            select: jest.fn().mockReturnValue({
              in: jest.fn().mockReturnValue({
                eq: jest
                  .fn()
                  .mockResolvedValue({ data: validSkillsData, error: null }),
              }),
            }),
          };
        } else if (fromCallCount === 3) {
          // user INSERT
          return {
            insert: jest.fn().mockReturnValue({
              select: jest.fn().mockReturnValue({ single: insertSingleFn }),
            }),
          };
        } else {
          // user_skills INSERT
          return {
            insert: jest
              .fn()
              .mockResolvedValue({ error: opts.userSkillsError ?? null }),
          };
        }
      }),
    };
  }

  describe('POST /api/v1/auth/invite', () => {
    it('AC1 — should return 201 with invite_id on successful invite', async () => {
      mockCreateAdmin.mockReturnValue(
        makeInviteMock({ insertData: { id: 'new-invite-uuid' } }),
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

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body).toEqual({ invite_id: 'new-invite-uuid' });
    });

    it('AC2 — should return 409 when phone is already active in tenant', async () => {
      mockCreateAdmin.mockReturnValue(
        makeInviteMock({
          activeMember: { id: 'existing-user', status: 'active' },
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
          activeMember: null,
          insertData: null,
          insertError: {
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

    it('AC5 — should return 400 when skillIds contain unknown UUIDs (not in tenant)', async () => {
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

    it('AC6 — should return 403 for Technician JWT', async () => {
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
    const INVITED_USER_ID = 'invited-tech-uuid';
    const invitedUser = {
      id: INVITED_USER_ID,
      country_code: '+91',
      phone_number: '2222222222',
      name: 'Ravi Kumar',
      role: 'technician',
      tenant_id: TENANT_ID,
      status: 'invited',
    };
    const activatedUser = { ...invitedUser, status: 'active' };

    function makeAutoAcceptMock() {
      let fromCallCount = 0;

      return {
        from: jest.fn().mockImplementation(() => {
          fromCallCount++;
          if (fromCallCount === 1) {
            // First call: findOrCreateUser select (eq x2 for country_code + phone_number)
            return {
              select: jest.fn().mockReturnValue({
                eq: jest.fn().mockReturnValue({
                  eq: jest.fn().mockReturnValue({
                    single: jest
                      .fn()
                      .mockResolvedValue({ data: invitedUser, error: null }),
                  }),
                }),
              }),
            };
          } else {
            // Second call: auto-accept UPDATE (.eq('id').eq('status','invited').select().single())
            return {
              update: jest.fn().mockReturnValue({
                eq: jest.fn().mockReturnValue({
                  eq: jest.fn().mockReturnValue({
                    select: jest.fn().mockReturnValue({
                      single: jest.fn().mockResolvedValue({
                        data: activatedUser,
                        error: null,
                      }),
                    }),
                  }),
                }),
              }),
            };
          }
        }),
      };
    }

    it('AC3 — invited user OTP verify should return JWT with correct tenantId and role', async () => {
      mockCreateAdmin.mockReturnValue(makeAutoAcceptMock());

      const sendResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/send',
        payload: { countryCode: '+91', phoneNumber: '2222222222' },
      });
      expect(sendResponse.statusCode).toBe(200);
      const { otp_session_id } = JSON.parse(sendResponse.body);

      const verifyResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/verify',
        payload: { otpSessionId: otp_session_id, otpCode: '123456' },
      });

      expect(verifyResponse.statusCode).toBe(200);
      const body = JSON.parse(verifyResponse.body);
      expect(body.token).toBeDefined();
      expect(body.user.tenantId).toBe(TENANT_ID);
      expect(body.user.role).toBe('technician');
    });
  });
});
