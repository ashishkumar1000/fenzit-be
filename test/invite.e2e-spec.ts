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
import { PgPoolFactory } from '../src/common/pg/pg-pool.factory';
import { Role } from '../src/common/enums/role.enum';
import { accessToken, withPeople } from './helpers/auth-test-utils';
import { withOpenSubscription } from './helpers/open-subscription-admin';
import { SmsDeliveryProvider } from '../src/auth/sms-delivery.provider';

// Go-live (2026-11-17): the DLT template is approved and sending is on, so a
// successful invite runs the full send path — status guard, cap reserve and
// the (mocked) provider — and answers sms_status 'sent'.

// The cap hash needs its key. Config only requires it in production, so the
// test supplies a throwaway value.
process.env['INVITE_SMS_HASH_KEY'] ??=
  'e2e-test-invite-sms-hash-key-0123456789';

describe('Member Invitation (e2e)', () => {
  let app: NestFastifyApplication;
  let jwtService: JwtService;
  let mockCreateAdmin: jest.Mock;
  let mockSend: jest.Mock;
  // The invite's one all-or-nothing step runs in the pg pool; each test
  // installs its SQL-dispatching fake tx here (see makeInviteTx below).
  let currentTx: { query: jest.Mock } | null = null;

  const TENANT_ID = '33333333-3333-4333-8333-333333333333';
  const OWNER_ID = '11111111-1111-4111-8111-111111111111';
  const TECH_ID = '22222222-2222-4222-8222-222222222222';
  const VIEWER_ID = '77777777-7777-4777-8777-777777777777';
  const NEW_USER_ID = '88888888-8888-4888-8888-888888888888';
  const SKILL_ID = '550e8400-e29b-41d4-a716-446655440001';

  beforeAll(async () => {
    mockCreateAdmin = jest.fn();
    mockSend = jest.fn().mockResolvedValue(undefined);

    const moduleFixture: TestingModule = await withPeople(
      Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(SupabaseClientFactory)
        .useValue({
          create: jest.fn(),
          createAdmin: () => withOpenSubscription(mockCreateAdmin()),
        })
        .overrideProvider(SmsDeliveryProvider)
        .useValue({ send: (...args: unknown[]) => mockSend(...args) })
        .overrideProvider(PgPoolFactory)
        .useValue({
          withTransaction: (work: (tx: unknown) => Promise<unknown>) =>
            work(currentTx),
          onModuleDestroy: async () => undefined,
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

  /** Builds a Supabase admin mock for the invite endpoint's database calls:
   *  1. from('skills').select().in().eq()  — global skills-catalog check
   *  2. rpc('write_audit_row', ...)        — the post-commit audit entry
   *  Then the SMS send path (sending is on): the status guard's
   *  from('memberships') read, rpc('invite_sms_reserve_send') for the cap,
   *  and the audit insert.
   */
  function makeInviteMock(opts: { validSkills?: { id: string }[] }) {
    const validSkillsData =
      opts.validSkills !== undefined ? opts.validSkills : [{ id: SKILL_ID }];
    const rpc = jest.fn((name: string) => {
      if (name === 'write_audit_row') {
        return Promise.resolve({ data: null, error: null });
      }
      if (name === 'invite_sms_reserve_send') {
        return Promise.resolve({ data: 'counter-1', error: null });
      }
      throw new Error(`unexpected rpc ${name}`);
    });
    const auditInsert = jest.fn().mockResolvedValue({ error: null });
    return {
      rpc,
      auditInsert,
      from: jest.fn().mockImplementation((table: string) => {
        if (table === 'skills') {
          return {
            select: jest.fn().mockReturnValue({
              in: jest.fn().mockReturnValue({
                eq: jest
                  .fn()
                  .mockResolvedValue({ data: validSkillsData, error: null }),
              }),
            }),
          };
        }
        if (table === 'memberships') {
          // The status guard: the membership is still pending.
          return {
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                eq: jest.fn().mockReturnValue({
                  maybeSingle: jest.fn().mockResolvedValue({
                    data: { status: 'invited' },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === 'invite_sms_audit') {
          return { insert: auditInsert };
        }
        throw new Error(`unexpected table ${table}`);
      }),
    };
  }

  interface InviteTxOpts {
    callerIsAdmin?: boolean;
    personFound?: boolean;
    sameTeam?: boolean;
    elsewhere?: boolean;
    /** Codes already in memberships — the mint loop must step over them. */
    takenCodes?: string[];
    seqStart?: number;
    /** The membership insert rejects with this pg error (every attempt). */
    membershipError?: { code: string; constraint?: string };
  }

  /** SQL-dispatching fake of the pg transaction the invite runs inside
   *  (pgPool.withTransaction — the same shape as the unit harness in
   *  auth.service.spec): each statement the service sends maps to one arm,
   *  and unclassified SQL throws, so the mock tracks the service's contract.
   */
  function makeInviteTx(opts: InviteTxOpts = {}) {
    let seq = opts.seqStart ?? 1;
    const bumps: number[] = [];
    const membershipInserts: unknown[][] = [];
    const tx = {
      query: jest.fn(
        (sql: string, params: unknown[] = []): Promise<unknown> => {
          // Savepoint traffic around each mint attempt (rollback/release
          // both contain the word 'savepoint'). No abort modeling here: no
          // e2e scenario continues past a failed statement, so plain
          // resolves track the contract.
          if (sql.includes('rollback to savepoint'))
            return Promise.resolve({ rows: [], rowCount: 0 });
          if (sql.includes('release savepoint'))
            return Promise.resolve({ rows: [], rowCount: 0 });
          if (sql.includes('savepoint invite_code_mint'))
            return Promise.resolve({ rows: [], rowCount: 0 });
          if (sql.includes('pg_advisory_xact_lock'))
            return Promise.resolve({ rows: [], rowCount: 0 });
          if (sql.includes('attendance_lock_tenant'))
            return Promise.resolve({ rows: [], rowCount: 0 });
          // Caller check under the locks.
          if (sql.includes('is_company_admin')) {
            if (opts.callerIsAdmin === false)
              return Promise.resolve({ rows: [], rowCount: 0 });
            return Promise.resolve({
              rows: [
                {
                  platform_admin: false,
                  disabled: false,
                  is_company_admin: true,
                },
              ],
              rowCount: 1,
            });
          }
          if (sql.includes('from public.tenants where id'))
            return Promise.resolve({ rows: [{ n: 1 }], rowCount: 1 });
          if (sql.includes('from public.country_codes'))
            return Promise.resolve({ rows: [{ dial_code: '+91' }], rowCount: 1 });
          // Person lookup by phone (for update).
          if (sql.includes('select id, name, platform_admin')) {
            if (!opts.personFound)
              return Promise.resolve({ rows: [], rowCount: 0 });
            return Promise.resolve({
              rows: [
                {
                  id: NEW_USER_ID,
                  name: null,
                  platform_admin: false,
                  disabled: false,
                },
              ],
              rowCount: 1,
            });
          }
          if (sql.includes('insert into public.users'))
            return Promise.resolve({ rows: [{ id: NEW_USER_ID }], rowCount: 1 });
          if (sql.includes('update public.users set name'))
            return Promise.resolve({ rows: [], rowCount: 1 });
          // Live-membership checks: same team vs. any company.
          if (sql.includes("status <> 'removed'")) {
            const taken = { rows: [{ n: 1 }], rowCount: 1 };
            const free = { rows: [], rowCount: 0 };
            return Promise.resolve(
              sql.includes('tenant_id = $2')
                ? opts.sameTeam
                  ? taken
                  : free
                : opts.elsewhere
                  ? taken
                  : free,
            );
          }
          // Removed-membership lookup (reactivation path) + its update.
          if (sql.includes('select id from public.memberships'))
            return Promise.resolve({ rows: [], rowCount: 0 });
          if (sql.includes('update public.memberships'))
            return Promise.resolve({
              rows: [{ employee_code: 'EMP-0007' }],
              rowCount: 1,
            });
          if (sql.includes('employee_sequences')) {
            bumps.push(seq);
            return Promise.resolve({ rows: [{ last_seq: seq++ }], rowCount: 1 });
          }
          // Employee-code existence check.
          if (sql.includes('tenant_id = $1 and employee_code = $2')) {
            const code = params[1] as string;
            return (opts.takenCodes ?? []).includes(code)
              ? Promise.resolve({ rows: [{ n: 1 }], rowCount: 1 })
              : Promise.resolve({ rows: [], rowCount: 0 });
          }
          if (sql.includes('insert into public.memberships')) {
            membershipInserts.push(params);
            if (opts.membershipError) {
              return Promise.reject(
                Object.assign(new Error('unique violation'), opts.membershipError),
              );
            }
            return Promise.resolve({
              rows: [{ employee_code: params[3] }],
              rowCount: 1,
            });
          }
          if (sql.includes('user_skills'))
            return Promise.resolve({ rows: [], rowCount: 0 });
          return Promise.reject(new Error(`unclassified invite SQL: ${sql}`));
        },
      ),
    };
    return { tx, bumps, membershipInserts };
  }

  describe('POST /api/v1/auth/invite', () => {
    it('AC1 — should return 201 with invite_id on successful invite', async () => {
      const admin = makeInviteMock({});
      mockCreateAdmin.mockReturnValue(admin);
      const world = makeInviteTx();
      currentTx = world.tx;

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
      // Sending is on (go-live 2026-11-17): the invite answers 'sent' and the
      // mocked provider received exactly one send.
      expect(body).toEqual({
        invite_id: NEW_USER_ID,
        employee_code: 'EMP-001',
        sms_status: 'sent',
      });
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(admin.auditInsert.mock.calls[0][0].outcome).toBe('sent');
      // The membership was minted inside the transaction — a new person, the
      // first free code, the role defaulting to employee.
      expect(world.membershipInserts).toEqual([
        [NEW_USER_ID, TENANT_ID, 'employee', 'EMP-001', OWNER_ID],
      ]);
      // The audit row followed the commit.
      expect(admin.rpc).toHaveBeenCalledWith(
        'write_audit_row',
        expect.objectContaining({
          p_actor: OWNER_ID,
          p_action: 'member.invite',
          p_tenant_id: TENANT_ID,
          p_target_user: NEW_USER_ID,
          p_details: {
            role: 'employee',
            reactivated: false,
            employee_code: 'EMP-001',
          },
        }),
      );
    });

    it('AC2 — should return 409 when phone already belongs to a company', async () => {
      mockCreateAdmin.mockReturnValue(makeInviteMock({}));
      // The person exists (invited by another company, still pending there) —
      // the live-membership check refuses them before any write.
      currentTx = makeInviteTx({ personFound: true, elsewhere: true }).tx;

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

    // A raw 23505 escaping the invite is an unrecognised constraint (the
    // code-mint loop retries its own known one). It used to be blanket-mapped
    // to the duplicate-phone 409 — which shipped the 2026-11-25 incident where
    // brand-new numbers failed as "already belongs to a company" — so it must
    // surface as the honest 500.
    it('should return 500 on an unrecognised unique constraint (23505)', async () => {
      mockCreateAdmin.mockReturnValue(makeInviteMock({}));
      currentTx = makeInviteTx({
        membershipError: { code: '23505', constraint: 'mystery_constraint' },
      }).tx;

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

      expect(response.statusCode).toBe(500);
      const body = JSON.parse(response.body);
      expect(body.error_code).toBe('INTERNAL_SERVER_ERROR');
    });

    // Changed 2026-11-11: skills are optional (commit d9fa073), so an empty
    // skillIds list is now a valid invite. The old "422 for an empty array"
    // expectation described a rule that no longer exists.
    it('AC3 — should accept an empty skillIds list (skills are optional)', async () => {
      const admin = makeInviteMock({});
      mockCreateAdmin.mockReturnValue(admin);
      const world = makeInviteTx();
      currentTx = world.tx;

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

      expect(response.statusCode).toBe(201);
      // An empty list attaches nothing: no user_skills statement was sent.
      expect(
        world.tx.query.mock.calls.filter(([sql]) =>
          (sql as string).includes('user_skills'),
        ),
      ).toEqual([]);
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

    it('should return 403 when the caller is not a company admin under the locks', async () => {
      mockCreateAdmin.mockReturnValue(makeInviteMock({}));
      // The JWT belongs to an owner, but the membership check inside the
      // transaction disagrees (demoted/removed between auth and the write).
      currentTx = makeInviteTx({ callerIsAdmin: false }).tx;

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
      expect(JSON.parse(response.body).error_code).toBe('FORBIDDEN');
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

    // The format contract for phoneNumber moved here from the deleted
    // invite_member RPC suites (2026-11-25 drop): the service never
    // re-checks it and the DB has no constraint, so the DTO regex is the
    // only guard. Both sides of /^\d{6,15}$/ are pinned.
    it.each(['12345', '1234567890123456', '98765abcde', '٩٨٧٦٥٤٣٢١٠', ''])(
      'should return 422 for a malformed phoneNumber (%s)',
      async (badPhone) => {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/invite',
          headers: { authorization: `Bearer ${ownerJwt()}` },
          payload: {
            countryCode: '+91',
            phoneNumber: badPhone,
            name: 'Ravi Kumar',
            skillIds: [SKILL_ID],
          },
        });

        expect(response.statusCode).toBe(422);
        const body = JSON.parse(response.body) as { error_code: string };
        expect(body.error_code).toBe('VALIDATION_ERROR');
      },
    );

    it('should return 422 for an invalid role (outside MEMBERSHIP_ROLES)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/invite',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: {
          countryCode: '+91',
          phoneNumber: '1111111111',
          name: 'Ravi Kumar',
          role: 'owner',
          skillIds: [SKILL_ID],
        },
      });

      expect(response.statusCode).toBe(422);
      const body = JSON.parse(response.body) as { error_code: string };
      expect(body.error_code).toBe('VALIDATION_ERROR');
    });

    it('should accept the 6-digit phoneNumber boundary', async () => {
      const admin = makeInviteMock({});
      mockCreateAdmin.mockReturnValue(admin);
      const world = makeInviteTx();
      currentTx = world.tx;

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/invite',
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: {
          countryCode: '+91',
          phoneNumber: '999981',
          name: 'Ravi Kumar',
          skillIds: [SKILL_ID],
        },
      });

      expect(response.statusCode).toBe(201);
      expect(world.membershipInserts).toEqual([
        [NEW_USER_ID, TENANT_ID, 'employee', 'EMP-001', OWNER_ID],
      ]);
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
      phone_number: '9222222222',
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
                  maybeSingle: jest.fn().mockResolvedValue({
                    data: invitedMembership,
                    error: null,
                  }),
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
            data:
              chain.eq.mock.calls.length > 1
                ? invitedUser
                : { platform_admin: false },
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
        payload: { countryCode: '+91', phoneNumber: '9222222222' },
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
