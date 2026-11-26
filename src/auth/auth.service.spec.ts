import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  InternalServerErrorException,
  UnauthorizedException,
  HttpException,
} from '@nestjs/common';
import { AuthService, REALTIME_TOKEN_TTL_SECONDS } from './auth.service';
import { OtpSessionStore, OtpSession } from './otp-session-store';
import { InviteSmsService } from './invite-sms/invite-sms.service';
import { SmsDeliveryProvider, SmsDeliveryError } from './sms-delivery.provider';
import { SMS_TEMPLATES } from '../common/constants/sms-templates';
import { ErrorCode } from '../common/enums/error-code.enum';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { PgPoolFactory } from '../common/pg/pg-pool.factory';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import { SendOtpDto } from './dto/send-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { SetupCompanyDto } from './dto/setup-company.dto';
import { InviteMemberDto } from './dto/invite-member.dto';
import * as bcrypt from 'bcrypt';

/** A chainable query stub: every filter returns itself, the end call resolves `result`. */
function queryChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, jest.Mock> = {};
  for (const m of ['select', 'eq', 'neq', 'in']) {
    chain[m] = jest.fn(() => chain);
  }
  chain['maybeSingle'] = jest.fn().mockResolvedValue(result);
  chain['single'] = jest.fn().mockResolvedValue(result);
  return chain;
}

/**
 * Admin client for the sign-in path: the users lookup (and the platform_admin
 * read) answer with `user`; the memberships read answers with `membership`;
 * the membership activation update is captured.
 */
function loginAdmin(opts: {
  user: object;
  membership?: { tenant_id: string; role: string; status: string } | null;
  activateError?: { message: string } | null;
}) {
  const activateStatusEq = jest
    .fn()
    .mockResolvedValue({ error: opts.activateError ?? null });
  const activateUserEq = jest.fn(() => ({ eq: activateStatusEq }));
  const update = jest.fn(() => ({ eq: activateUserEq }));
  const memberships = {
    ...queryChain({ data: opts.membership ?? null, error: null }),
    update,
  };
  const users = queryChain({ data: opts.user, error: null });
  return {
    update,
    activateUserEq,
    activateStatusEq,
    memberships,
    from: jest.fn((table: string) => (table === 'users' ? users : memberships)),
  };
}

const userRow = (over: Record<string, unknown> = {}) => ({
  id: '550e8400-e29b-41d4-a716-446655440000',
  country_code: '+91',
  phone_number: '1234567890',
  name: null,
  platform_admin: false,
  disabled: false,
  ...over,
});

// startCompanyValidity writes tenants.update(...).eq(...).is(...); the
// 23-13 catalog seed upserts leave_types — both ride the same fallback
// builder every non-table-routed from() call lands on.
const validityWrite = () => ({
  update: jest.fn().mockReturnValue({
    eq: jest.fn().mockReturnValue({
      is: jest.fn().mockResolvedValue({ error: null }),
    }),
  }),
  upsert: jest.fn().mockResolvedValue({ error: null }),
});

describe('AuthService', () => {
  let service: AuthService;
  let otpSessionStore: jest.Mocked<OtpSessionStore>;
  let smsDeliveryProvider: jest.Mocked<SmsDeliveryProvider>;
  let supabaseClientFactory: jest.Mocked<SupabaseClientFactory>;
  let jwtService: jest.Mocked<JwtService>;
  let inviteSmsService: { sendInviteSms: jest.Mock };
  // The invite runs inside pgPool.withTransaction; the fake hands it whatever
  // tx the current test installed (only the invite tests install one).
  let currentTx: { query: jest.Mock } | null = null;
  let withTransaction: jest.Mock;

  beforeEach(async () => {
    // The invite fake is installed per-test; never let one leak into the next.
    currentTx = null;
    const mockOtpSessionStore = {
      set: jest.fn(),
      get: jest.fn(),
      delete: jest.fn(),
      increment: jest.fn(),
    };

    const mockSmsDeliveryProvider = {
      send: jest.fn(),
    };

    const mockSupabaseClientFactory = {
      create: jest.fn(),
      createAdmin: jest.fn(),
    };

    const mockJwtService = {
      signAsync: jest.fn(),
    };

    // Invite SMS is covered by its own tests (story 21-1 test list); here it
    // only has to exist so AuthService can be built.
    const mockInviteSmsService = {
      sendInviteSms: jest.fn().mockResolvedValue('not_configured'),
    };

    withTransaction = jest.fn((work: (tx: unknown) => Promise<unknown>) =>
      work(currentTx),
    );
    const mockPgPoolFactory = { withTransaction };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: OtpSessionStore, useValue: mockOtpSessionStore },
        { provide: SmsDeliveryProvider, useValue: mockSmsDeliveryProvider },
        { provide: SupabaseClientFactory, useValue: mockSupabaseClientFactory },
        { provide: JwtService, useValue: mockJwtService },
        { provide: InviteSmsService, useValue: mockInviteSmsService },
        { provide: PgPoolFactory, useValue: mockPgPoolFactory },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    otpSessionStore = module.get(OtpSessionStore);
    smsDeliveryProvider = module.get(SmsDeliveryProvider);
    supabaseClientFactory = module.get(SupabaseClientFactory);
    jwtService = module.get(JwtService);
    inviteSmsService = module.get(InviteSmsService);
  });

  describe('sendOtp', () => {
    it('should send OTP for valid phone parts', async () => {
      const dto: SendOtpDto = { countryCode: '+91', phoneNumber: '1234567890' };
      otpSessionStore.increment.mockResolvedValue({
        count: 1,
        windowRemainingSeconds: 600,
      });
      smsDeliveryProvider.send.mockResolvedValue(undefined);
      otpSessionStore.set.mockResolvedValue(undefined);

      const result = await service.sendOtp(dto);

      expect(result).toHaveProperty('otp_session_id');
      expect(result).toHaveProperty('expires_at');
      expect(otpSessionStore.increment).toHaveBeenCalledWith(
        '+911234567890',
        600,
      );
      expect(smsDeliveryProvider.send).toHaveBeenCalledWith(
        '+911234567890',
        SMS_TEMPLATES.OTP_LOGIN,
        { number: expect.stringMatching(/^\d{4}$/) },
      );
    });

    it('should store countryCode and phoneNumber separately in the session', async () => {
      const dto: SendOtpDto = { countryCode: '+91', phoneNumber: '9876543210' };
      otpSessionStore.increment.mockResolvedValue({
        count: 1,
        windowRemainingSeconds: 600,
      });
      smsDeliveryProvider.send.mockResolvedValue(undefined);
      otpSessionStore.set.mockResolvedValue(undefined);

      await service.sendOtp(dto);

      expect(otpSessionStore.set).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          countryCode: '+91',
          phoneNumber: '9876543210',
        }),
        expect.any(Number),
      );
    });

    it('should throw rate limit error after 5 sends, reporting the window REMAINING as retryAfterSeconds', async () => {
      const dto: SendOtpDto = { countryCode: '+91', phoneNumber: '1234567890' };
      otpSessionStore.increment.mockResolvedValue({
        count: 6,
        windowRemainingSeconds: 333,
      });

      // GlobalExceptionFilter lifts retryAfterSeconds into the Retry-After
      // response header — same contract as the places 429s.
      await expect(service.sendOtp(dto)).rejects.toMatchObject({
        status: 429,
        response: expect.objectContaining({ retryAfterSeconds: 333 }),
      });
    });

    it('NEVER echoes the code in the response — flag on or off (the master code is the only testing channel)', async () => {
      const prevEcho = process.env['OTP_DEV_ECHO'];
      process.env['OTP_DEV_ECHO'] = 'true';
      try {
        const dto: SendOtpDto = {
          countryCode: '+91',
          phoneNumber: '1234567890',
        };
        otpSessionStore.increment.mockResolvedValue({
          count: 1,
          windowRemainingSeconds: 600,
        });
        smsDeliveryProvider.send.mockResolvedValue(undefined);
        otpSessionStore.set.mockResolvedValue(undefined);

        const result = await service.sendOtp(dto);

        // The send endpoint is public — an echoed code in its response is
        // equivalent to having no OTP factor (bug-bash 2026-10-02 F2). The
        // old OTP_DEV_ECHO echo is gone entirely; asserting under the flag
        // ON (the test env's default) pins the strongest case.
        expect(result).not.toHaveProperty('otp');
        expect(result.otp_session_id).toBeDefined();
      } finally {
        if (prevEcho === undefined) delete process.env['OTP_DEV_ECHO'];
        else process.env['OTP_DEV_ECHO'] = prevEcho;
      }
    });

    // --- Delivery failure semantics (PRD FR-BE4) --------------------------

    it('a definitive provider failure answers 502 OTP_SEND_FAILED and deletes the just-created session', async () => {
      const dto: SendOtpDto = { countryCode: '+91', phoneNumber: '1234567890' };
      otpSessionStore.increment.mockResolvedValue({
        count: 1,
        windowRemainingSeconds: 600,
      });
      otpSessionStore.set.mockResolvedValue(undefined);
      otpSessionStore.delete.mockResolvedValue(undefined);
      smsDeliveryProvider.send.mockRejectedValue(
        new SmsDeliveryError('MSG91 send rejected (HTTP 402)', 'error'),
      );

      await expect(service.sendOtp(dto)).rejects.toMatchObject({
        status: 502,
        response: expect.objectContaining({
          error_code: ErrorCode.OTP_SEND_FAILED,
        }),
      });
      // Nobody received anything — the session must not linger verifyable.
      expect(otpSessionStore.delete).toHaveBeenCalledWith(expect.any(String));
    });

    it('a provider TIMEOUT answers 502 OTP_SEND_FAILED but KEEPS the session (the SMS may still arrive)', async () => {
      const dto: SendOtpDto = { countryCode: '+91', phoneNumber: '1234567890' };
      otpSessionStore.increment.mockResolvedValue({
        count: 1,
        windowRemainingSeconds: 600,
      });
      otpSessionStore.set.mockResolvedValue(undefined);
      smsDeliveryProvider.send.mockRejectedValue(
        new SmsDeliveryError('MSG91 send timed out after 4000ms', 'timeout'),
      );

      await expect(service.sendOtp(dto)).rejects.toMatchObject({
        status: 502,
        response: expect.objectContaining({
          error_code: ErrorCode.OTP_SEND_FAILED,
        }),
      });
      expect(otpSessionStore.delete).not.toHaveBeenCalled();
    });

    it('a rate-limited retry after a failed send is ACCEPTED (the counter stays incremented — the limit is not bypassable via a failing provider)', async () => {
      // The 5th send fails (the cap allows 5); the 6th must still hit the
      // 429, not bypass it.
      const dto: SendOtpDto = { countryCode: '+91', phoneNumber: '1234567890' };
      otpSessionStore.increment
        .mockResolvedValueOnce({ count: 5, windowRemainingSeconds: 500 })
        .mockResolvedValueOnce({ count: 6, windowRemainingSeconds: 480 });
      otpSessionStore.set.mockResolvedValue(undefined);
      smsDeliveryProvider.send.mockRejectedValue(
        new SmsDeliveryError('MSG91 send rejected', 'error'),
      );
      otpSessionStore.delete.mockResolvedValue(undefined);

      await expect(service.sendOtp(dto)).rejects.toMatchObject({
        status: 502,
      });
      await expect(service.sendOtp(dto)).rejects.toMatchObject({
        status: 429,
      });
    });

    it('an unexpected (non-SmsDeliveryError) provider crash propagates as-is, not as a 502', async () => {
      const dto: SendOtpDto = { countryCode: '+91', phoneNumber: '1234567890' };
      otpSessionStore.increment.mockResolvedValue({
        count: 1,
        windowRemainingSeconds: 600,
      });
      otpSessionStore.set.mockResolvedValue(undefined);
      smsDeliveryProvider.send.mockRejectedValue(
        new Error('TypeError: Cannot read properties of undefined'),
      );
      const errorSpy = jest
        .spyOn(service['logger'], 'error')
        .mockImplementation(() => undefined);

      await expect(service.sendOtp(dto)).rejects.toThrow(
        'TypeError: Cannot read properties of undefined',
      );
      expect(otpSessionStore.delete).not.toHaveBeenCalled();
      // One otp_delivery line per attempt, EVERY outcome — a crash is a
      // structured 'crash' event, not silence (the metrics consume these).
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('"outcome":"crash"'),
      );
      errorSpy.mockRestore();
    });

    it('a failing session delete during a definitive delivery failure cannot mask the 502', async () => {
      const dto: SendOtpDto = { countryCode: '+91', phoneNumber: '1234567890' };
      otpSessionStore.increment.mockResolvedValue({
        count: 1,
        windowRemainingSeconds: 600,
      });
      otpSessionStore.set.mockResolvedValue(undefined);
      otpSessionStore.delete.mockRejectedValue(
        new Error('store temporarily unavailable'),
      );
      smsDeliveryProvider.send.mockRejectedValue(
        new SmsDeliveryError('MSG91 send rejected (HTTP 402)', 'error'),
      );

      // The client must see the delivery failure (502 OTP_SEND_FAILED), not
      // the store's 500.
      await expect(service.sendOtp(dto)).rejects.toMatchObject({
        status: 502,
        response: expect.objectContaining({
          error_code: ErrorCode.OTP_SEND_FAILED,
        }),
      });
    });
  });

  describe('verifyOtp', () => {
    /** Arrange a live session whose REAL code differs from the given one, so
     *  only the pre-release master path can verify. */
    function mockLiveSession() {
      otpSessionStore.get.mockResolvedValue({
        countryCode: '+91',
        phoneNumber: '1234567890',
        otpHash: bcrypt.hashSync('999999', 10),
        attempts: 0,
        locked: false,
        expiresAt: Date.now() + 300_000,
      });
      otpSessionStore.delete.mockResolvedValue(undefined);
      jwtService.signAsync.mockResolvedValueOnce('master-jwt');
      supabaseClientFactory.createAdmin.mockReturnValue(
        loginAdmin({ user: userRow() }) as never,
      );
    }

    it('PRE-RELEASE MASTER OTP: 1039 verifies ANY live session while OTP_DEV_ECHO=true (user-directed, remove at go-live)', async () => {
      const prevEcho = process.env['OTP_DEV_ECHO'];
      process.env['OTP_DEV_ECHO'] = 'true';
      try {
        mockLiveSession();
        const result = await service.verifyOtp({
          otpSessionId: 'session-id',
          otpCode: '1039',
        });
        expect(result).toHaveProperty('token', 'master-jwt');
        expect(otpSessionStore.delete).toHaveBeenCalled();
      } finally {
        if (prevEcho === undefined) delete process.env['OTP_DEV_ECHO'];
        else process.env['OTP_DEV_ECHO'] = prevEcho;
      }
    });

    it('the master code is DEAD once OTP_DEV_ECHO is unset (the go-live flag flip removes it)', async () => {
      const prevEcho = process.env['OTP_DEV_ECHO'];
      delete process.env['OTP_DEV_ECHO'];
      try {
        mockLiveSession();
        await expect(
          service.verifyOtp({ otpSessionId: 'session-id', otpCode: '1039' }),
        ).rejects.toMatchObject({
          status: 401,
          response: expect.objectContaining({ error_code: 'INVALID_OTP' }),
        });
      } finally {
        if (prevEcho === undefined) delete process.env['OTP_DEV_ECHO'];
        else process.env['OTP_DEV_ECHO'] = prevEcho;
      }
    });

    it('should verify OTP and issue JWT for valid code', async () => {
      const otp = '123456';
      const otpHash = await bcrypt.hash(otp, 10);
      const session: OtpSession = {
        countryCode: '+91',
        phoneNumber: '1234567890',
        otpHash,
        attempts: 0,
        locked: false,
        expiresAt: Date.now() + 300_000,
      };

      const userId = '550e8400-e29b-41d4-a716-446655440000';

      otpSessionStore.get.mockResolvedValue(session);
      jwtService.signAsync.mockResolvedValueOnce('final-jwt');
      otpSessionStore.delete.mockResolvedValue(undefined);
      supabaseClientFactory.createAdmin.mockReturnValue(
        loginAdmin({ user: userRow({ id: userId }) }) as never,
      );

      const result = await service.verifyOtp({
        otpSessionId: 'session-id',
        otpCode: otp,
      });

      expect(result).toHaveProperty('token', 'final-jwt');
      // A new person has no company yet: role and tenant are null.
      expect(result.user).toEqual({
        userId,
        tenantId: null,
        role: null,
        name: null,
        platformAdmin: false,
        formerMember: false,
      });
      // The login token is identity only: no tenantId, no role.
      expect(jwtService.signAsync).toHaveBeenCalledWith({
        sub: userId,
        typ: 'access',
      });
      expect(otpSessionStore.delete).toHaveBeenCalled();
    });

    it('should reject a wrong code with INVALID_OTP and count the attempt', async () => {
      const otpHash = await bcrypt.hash('123456', 10);
      const session: OtpSession = {
        countryCode: '+91',
        phoneNumber: '1234567890',
        otpHash,
        attempts: 0,
        locked: false,
        expiresAt: Date.now() + 300_000,
      };

      otpSessionStore.get.mockResolvedValue(session);
      otpSessionStore.set.mockResolvedValue(undefined);

      await expect(
        service.verifyOtp({ otpSessionId: 'session-id', otpCode: '999999' }),
      ).rejects.toMatchObject({
        status: 401,
        response: expect.objectContaining({ error_code: 'INVALID_OTP' }),
      });
      // The failed attempt is persisted so the lockout ladder can climb.
      expect(otpSessionStore.set).toHaveBeenCalledWith(
        'session-id',
        expect.objectContaining({ attempts: 1, locked: false }),
        expect.any(Number),
      );
      expect(otpSessionStore.delete).not.toHaveBeenCalled();
    });

    it('should lock the session after 5 wrong codes — the correct code then answers OTP_SESSION_LOCKED', async () => {
      const otpHash = await bcrypt.hash('123456', 10);
      const session: OtpSession = {
        countryCode: '+91',
        phoneNumber: '1234567890',
        otpHash,
        attempts: 0,
        locked: false,
        expiresAt: Date.now() + 300_000,
      };

      otpSessionStore.get.mockImplementation(async () => ({ ...session }));
      otpSessionStore.set.mockImplementation(
        async (_id: string, s: OtpSession) => {
          session.attempts = s.attempts;
          session.locked = s.locked;
          return undefined;
        },
      );

      for (let attempt = 1; attempt <= 5; attempt++) {
        await expect(
          service.verifyOtp({ otpSessionId: 'session-id', otpCode: '000000' }),
        ).rejects.toMatchObject({
          response: expect.objectContaining({ error_code: 'INVALID_OTP' }),
        });
      }

      // The 5th failure locked the session in the store.
      expect(session).toMatchObject({ attempts: 5, locked: true });

      // Even the CORRECT code is refused while locked (brute force dies here).
      otpSessionStore.get.mockResolvedValue({
        ...session,
      });
      await expect(
        service.verifyOtp({ otpSessionId: 'session-id', otpCode: '123456' }),
      ).rejects.toMatchObject({
        status: 401,
        response: expect.objectContaining({ error_code: 'OTP_SESSION_LOCKED' }),
      });
    });

    it('should throw error if session is locked', async () => {
      const session: OtpSession = {
        countryCode: '+91',
        phoneNumber: '1234567890',
        otpHash: await bcrypt.hash('123456', 10),
        attempts: 5,
        locked: true,
        expiresAt: Date.now() + 300_000,
      };

      otpSessionStore.get.mockResolvedValue(session);

      await expect(
        service.verifyOtp({ otpSessionId: 'session-id', otpCode: '123456' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw error if session expired', async () => {
      otpSessionStore.get.mockResolvedValue(null);

      await expect(
        service.verifyOtp({ otpSessionId: 'session-id', otpCode: '123456' }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('setupCompany', () => {
    const ownerUser: RequestUser = {
      userId: '550e8400-e29b-41d4-a716-446655440000',
      tenantId: null,
      role: null,
      platformAdmin: false,
      rawJwt: 'mock-jwt',
    };

    const dto: SetupCompanyDto = {
      companyName: 'Jobzo Services',
      stateCode: 'KA',
      gstin: '29ABCDE1234F1Z5',
    };

    const rpcRow = {
      id: 'tenant-uuid',
      created_by: ownerUser.userId,
      company_name: 'Jobzo Services',
      gstin: '29ABCDE1234F1Z5',
      address: null,
      state_code: 'KA',
      upi_vpa: null,
      created_at: '2026-06-20T00:00:00Z',
      updated_at: '2026-06-20T00:00:00Z',
    };

    it('should return tenant, created=true, and fresh JWT on first call (201 path)', async () => {
      const upsert = jest.fn().mockResolvedValue({ error: null });
      const mockAdmin = {
        rpc: jest.fn().mockResolvedValue({
          data: [{ ...rpcRow, inserted: true }],
          error: null,
        }),
        from: jest.fn((table: string) =>
          table === 'leave_types'
            ? { upsert }
            : {
                insert: jest.fn().mockResolvedValue({ error: null }),
                ...validityWrite(),
              },
        ),
      };
      supabaseClientFactory.createAdmin.mockReturnValue(mockAdmin as never);
      jwtService.signAsync.mockResolvedValueOnce('fresh-owner-jwt');

      const result = await service.setupCompany(ownerUser, dto);

      expect(result.created).toBe(true);
      expect(result.token).toBe('fresh-owner-jwt');
      expect(result.tenant).toMatchObject({
        id: 'tenant-uuid',
        createdBy: ownerUser.userId,
        companyName: 'Jobzo Services',
      });
      // The FIXED catalog (23-13) seeds with the setup: the four codes,
      // their inherent modes and defaults, idempotent on (tenant_id, code).
      expect(upsert).toHaveBeenCalledTimes(1);
      const [rows, options] = upsert.mock.calls[0] as unknown as [
        Array<Record<string, unknown>>,
        { onConflict: string; ignoreDuplicates: boolean },
      ];
      expect(rows.map((r) => r.code).sort()).toEqual([
        'bereavement',
        'comp_off',
        'earned',
        'sick',
      ]);
      expect(rows.find((r) => r['code'] === 'earned')).toMatchObject({
        accrual_mode: 'monthly',
        accrual_days: 1,
        carry_forward: true,
        paid: true,
        enabled: true,
        tenant_id: 'tenant-uuid',
      });
      expect(options).toEqual({
        onConflict: 'tenant_id,code',
        ignoreDuplicates: true,
      });
    });

    it('a failed catalog seed fails the setup with 500 (the retry heals it)', async () => {
      const mockAdmin = {
        rpc: jest.fn().mockResolvedValue({
          data: [{ ...rpcRow, inserted: true }],
          error: null,
        }),
        from: jest.fn((table: string) =>
          table === 'leave_types'
            ? {
                upsert: jest
                  .fn()
                  .mockResolvedValue({ error: { message: 'db down' } }),
              }
            : validityWrite(),
        ),
      };
      supabaseClientFactory.createAdmin.mockReturnValue(mockAdmin as never);

      await expect(service.setupCompany(ownerUser, dto)).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('should save the owner name on their users row when provided', async () => {
      const eq = jest.fn().mockResolvedValue({ error: null });
      const update = jest.fn().mockReturnValue({ eq });
      const mockAdmin = {
        rpc: jest.fn().mockResolvedValue({
          data: [{ ...rpcRow, inserted: true }],
          error: null,
        }),
        from: jest.fn((table: string) =>
          table === 'users' ? { update } : validityWrite(),
        ),
      };
      supabaseClientFactory.createAdmin.mockReturnValue(mockAdmin as never);
      jwtService.signAsync.mockResolvedValueOnce('fresh-owner-jwt');

      const result = await service.setupCompany(ownerUser, {
        ...dto,
        name: 'Ravi Kumar',
      });

      expect(result.created).toBe(true);
      expect(mockAdmin.from).toHaveBeenCalledWith('users');
      expect(update).toHaveBeenCalledWith({ name: 'Ravi Kumar' });
      expect(eq).toHaveBeenCalledWith('id', ownerUser.userId);
    });

    it('should not touch the users row when no name is sent (backward compat)', async () => {
      const mockAdmin = {
        rpc: jest.fn().mockResolvedValue({
          data: [{ ...rpcRow, inserted: true }],
          error: null,
        }),
        from: jest.fn().mockReturnValue({
          insert: jest.fn().mockResolvedValue({ error: null }),
          ...validityWrite(),
        }),
      };
      supabaseClientFactory.createAdmin.mockReturnValue(mockAdmin as never);
      jwtService.signAsync.mockResolvedValueOnce('fresh-owner-jwt');

      await service.setupCompany(ownerUser, dto);

      expect(mockAdmin.from).not.toHaveBeenCalledWith('users');
    });

    it('should still create the tenant when saving the name fails (non-fatal)', async () => {
      const eq = jest.fn().mockResolvedValue({ error: { message: 'db down' } });
      const mockAdmin = {
        rpc: jest.fn().mockResolvedValue({
          data: [{ ...rpcRow, inserted: true }],
          error: null,
        }),
        from: jest.fn((table: string) =>
          table === 'users'
            ? { update: jest.fn().mockReturnValue({ eq }) }
            : validityWrite(),
        ),
      };
      supabaseClientFactory.createAdmin.mockReturnValue(mockAdmin as never);
      jwtService.signAsync.mockResolvedValueOnce('fresh-owner-jwt');

      const result = await service.setupCompany(ownerUser, {
        ...dto,
        name: 'Ravi Kumar',
      });

      expect(result.created).toBe(true);
      expect(result.token).toBe('fresh-owner-jwt');
    });

    it('should return tenant, created=false, and fresh JWT on idempotent re-call (200 path)', async () => {
      const mockAdmin = {
        rpc: jest.fn().mockResolvedValue({
          data: [{ ...rpcRow, inserted: false }],
          error: null,
        }),
        from: jest.fn().mockReturnValue(validityWrite()),
      };
      supabaseClientFactory.createAdmin.mockReturnValue(mockAdmin as never);
      jwtService.signAsync.mockResolvedValueOnce('fresh-owner-jwt');

      const result = await service.setupCompany(ownerUser, dto);
      expect(result.created).toBe(false);
      expect(result.token).toBe('fresh-owner-jwt');
    });

    it('should throw BadRequestException when RPC returns an error', async () => {
      const mockAdmin = {
        rpc: jest
          .fn()
          .mockResolvedValue({ data: null, error: { message: 'DB error' } }),
      };
      supabaseClientFactory.createAdmin.mockReturnValue(mockAdmin as never);

      await expect(service.setupCompany(ownerUser, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('maps a platform admin refusal (PT403) to 403 and an existing-company person (PT409) to 409', async () => {
      const failWith = (code: string) =>
        supabaseClientFactory.createAdmin.mockReturnValue({
          rpc: jest.fn().mockResolvedValue({
            data: null,
            error: { code, message: 'refused' },
          }),
        } as never);

      failWith('PT403');
      await expect(service.setupCompany(ownerUser, dto)).rejects.toThrow(
        ForbiddenException,
      );
      failWith('PT409');
      await expect(service.setupCompany(ownerUser, dto)).rejects.toThrow(
        ConflictException,
      );
      expect(jwtService.signAsync).not.toHaveBeenCalled();
    });

    it('should throw InternalServerErrorException when RPC returns empty array', async () => {
      const mockAdmin = {
        rpc: jest.fn().mockResolvedValue({ data: [], error: null }),
      };
      supabaseClientFactory.createAdmin.mockReturnValue(mockAdmin as never);

      await expect(service.setupCompany(ownerUser, dto)).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('should throw InternalServerErrorException when RPC returns null data with no error', async () => {
      const mockAdmin = {
        rpc: jest.fn().mockResolvedValue({ data: null, error: null }),
      };
      supabaseClientFactory.createAdmin.mockReturnValue(mockAdmin as never);

      await expect(service.setupCompany(ownerUser, dto)).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('should pass null for optional fields when not provided', async () => {
      const minimalDto: SetupCompanyDto = {
        companyName: 'ACME',
        stateCode: 'MH',
      };
      const mockAdmin = {
        rpc: jest.fn().mockResolvedValue({
          data: [
            {
              ...rpcRow,
              company_name: 'ACME',
              state_code: 'MH',
              gstin: null,
              inserted: true,
            },
          ],
          error: null,
        }),
        from: jest.fn().mockReturnValue({
          insert: jest.fn().mockResolvedValue({ error: null }),
          ...validityWrite(),
        }),
      };
      supabaseClientFactory.createAdmin.mockReturnValue(mockAdmin as never);

      await service.setupCompany(ownerUser, minimalDto);

      expect(mockAdmin.rpc).toHaveBeenCalledWith(
        'setup_tenant_for_owner',
        expect.objectContaining({
          p_gstin: null,
          p_address: null,
          p_upi_vpa: null,
        }),
      );
      // Story 4.2 — the categories param (and the column it wrote) is gone.
      expect(mockAdmin.rpc.mock.calls[0][1]).not.toHaveProperty(
        'p_service_categories',
      );
    });

    it('should not seed tenant skills (the seeding path was removed with tenant_skills)', async () => {
      const mockAdmin = {
        rpc: jest.fn().mockResolvedValue({
          data: [{ ...rpcRow, inserted: true }],
          error: null,
        }),
        from: jest.fn().mockReturnValue({
          insert: jest.fn().mockResolvedValue({ error: null }),
          ...validityWrite(),
        }),
      };
      supabaseClientFactory.createAdmin.mockReturnValue(mockAdmin as never);
      jwtService.signAsync.mockResolvedValueOnce('fresh-jwt');

      await service.setupCompany(ownerUser, dto);

      expect(mockAdmin.from).not.toHaveBeenCalledWith('tenant_skills');
    });
  });

  describe('inviteMember', () => {
    const adminUser: RequestUser = {
      userId: '550e8400-e29b-41d4-a716-446655440000',
      tenantId: 'tenant-uuid-111',
      role: Role.COMPANY_ADMIN,
      platformAdmin: false,
      rawJwt: 'mock-jwt',
    };

    const SKILL_ID = '550e8400-e29b-41d4-a716-446655440001';

    const dto: InviteMemberDto = {
      countryCode: '+91',
      phoneNumber: '1111111111',
      name: 'Ravi Kumar',
      skillIds: [SKILL_ID],
    };

    /** Admin client for the post-transaction steps: the skills-catalog check
     *  (pre-tx) and the write_audit_row call (post-commit). */
    function makeInviteAdmin(
      opts: {
        validSkills?: { id: string }[];
        validSkillsError?: { code?: string; message?: string } | null;
        auditError?: { code?: string; message?: string } | null;
        auditReject?: unknown;
      } = {},
    ) {
      const validSkillsData =
        opts.validSkills !== undefined ? opts.validSkills : [{ id: SKILL_ID }];

      // Story 4.2 — captured so tests can assert the is_active filter.
      const skillCheckEq = jest.fn().mockResolvedValue({
        data: opts.validSkillsError ? null : validSkillsData,
        error: opts.validSkillsError ?? null,
      });
      const skillCheckIn = jest.fn().mockReturnValue({ eq: skillCheckEq });

      const rpc =
        opts.auditReject !== undefined
          ? jest.fn().mockRejectedValue(opts.auditReject)
          : jest.fn().mockResolvedValue({
              data: null,
              error: opts.auditError ?? null,
            });

      return {
        skillCheckEq,
        skillCheckIn,
        rpc,
        from: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnValue({ in: skillCheckIn }),
        }),
      };
    }

    interface TxOpts {
      /** The caller-check row: absent = caller missing (no user row). */
      callerMissing?: boolean;
      callerPlatformAdmin?: boolean;
      callerDisabled?: boolean;
      /** False = the caller is not an active company_admin of the tenant. */
      callerIsAdmin?: boolean;
      tenantMissing?: boolean;
      countryUnsupported?: boolean;
      /** True = a person with this phone already exists. Default: fresh number. */
      personFound?: boolean;
      personId?: string;
      /** Default null so the invite fills the name (the found-path branch). */
      personName?: string | null;
      personPlatformAdmin?: boolean;
      personDisabled?: boolean;
      sameTeam?: boolean;
      elsewhere?: boolean;
      /** A removed membership for this person in this tenant (reactivation). */
      removedMembershipId?: string;
      /** Codes the existence check reports as already taken. */
      takenCodes?: string[];
      /** The first counter bump returns this. Default 4 → EMP-004. */
      seqStart?: number;
      /** The membership insert rejects with this pg error (every attempt). */
      membershipError?: { code: string; constraint?: string };
      /** …unless onlyOnce, which rejects only the first attempt. */
      membershipErrorOnce?: boolean;
      /** The person insert rejects with this pg error (an unknown writer won the phone race). */
      userInsertError?: { code: string; constraint?: string };
      /** The chosen "Reports to" manager, as the membership read answers it. */
      manager?: { status: string; disabled: boolean } | null;
      /** The manager's branch would close a loop. */
      managerCycle?: boolean;
      /** How many managers stand above the chosen manager. */
      managerAncestors?: number;
    }

    /**
     * SQL-shape-dispatching fake tx for the invite (the buildSetActive style
     * from members.service.spec): each statement answers like the real DB
     * would, and unclassified SQL throws — the mock tracks the contract.
     */
    function makeInviteTx(opts: TxOpts = {}) {
      let seq = opts.seqStart ?? 4;
      const bumps: number[] = [];
      const membershipInserts: string[][] = [];
      const nameFills: string[][] = [];
      const savepoints: string[] = [];
      const releases: string[] = [];
      const rollbacksToSavepoint: string[] = [];
      // Real Postgres aborts the whole transaction on a failed statement —
      // every later statement answers 25P02 until ROLLBACK TO SAVEPOINT. The
      // fake models that, so a mint retry is only exercisable the way it
      // actually works on the database.
      let aborted = false;
      const query = jest.fn(
        (sql: string, params: unknown[] = []): Promise<unknown> => {
          // Savepoint traffic first (rollback/release both contain the word
          // 'savepoint'); the rollback un-poisons the transaction.
          if (sql.includes('rollback to savepoint')) {
            rollbacksToSavepoint.push(sql);
            aborted = false;
            return Promise.resolve({ rows: [], rowCount: 0 });
          }
          if (aborted)
            return Promise.reject(
              Object.assign(
                new Error(
                  'current transaction is aborted, commands ignored until end of transaction block',
                ),
                { code: '25P02' },
              ),
            );
          if (sql.includes('release savepoint')) {
            releases.push(sql);
            return Promise.resolve({ rows: [], rowCount: 0 });
          }
          if (sql.includes('savepoint invite_code_mint')) {
            savepoints.push(sql);
            return Promise.resolve({ rows: [], rowCount: 0 });
          }
          if (sql.includes('pg_advisory_xact_lock'))
            return Promise.resolve({ rows: [], rowCount: 0 });
          if (sql.includes('attendance_lock_tenant'))
            return Promise.resolve({ rows: [], rowCount: 0 });
          // Caller check under the locks.
          if (sql.includes('is_company_admin')) {
            if (opts.callerMissing)
              return Promise.resolve({ rows: [], rowCount: 0 });
            return Promise.resolve({
              rows: [
                {
                  platform_admin: opts.callerPlatformAdmin ?? false,
                  disabled: opts.callerDisabled ?? false,
                  is_company_admin: opts.callerIsAdmin ?? true,
                },
              ],
              rowCount: 1,
            });
          }
          if (sql.includes('from public.tenants where id')) {
            return opts.tenantMissing
              ? Promise.resolve({ rows: [], rowCount: 0 })
              : Promise.resolve({ rows: [{ n: 1 }], rowCount: 1 });
          }
          if (sql.includes('from public.country_codes')) {
            return opts.countryUnsupported
              ? Promise.resolve({ rows: [], rowCount: 0 })
              : Promise.resolve({ rows: [{ dial_code: '+91' }], rowCount: 1 });
          }
          // Person lookup by phone (for update).
          if (sql.includes('select id, name, platform_admin')) {
            if (!opts.personFound)
              return Promise.resolve({ rows: [], rowCount: 0 });
            return Promise.resolve({
              rows: [
                {
                  id: opts.personId ?? 'person-uuid-1',
                  name: opts.personName === undefined ? null : opts.personName,
                  platform_admin: opts.personPlatformAdmin ?? false,
                  disabled: opts.personDisabled ?? false,
                },
              ],
              rowCount: 1,
            });
          }
          if (sql.includes('insert into public.users')) {
            if (opts.userInsertError) {
              aborted = true;
              return Promise.reject(
                Object.assign(
                  new Error('unique violation'),
                  opts.userInsertError,
                ),
              );
            }
            return Promise.resolve({
              rows: [{ id: 'new-person-uuid' }],
              rowCount: 1,
            });
          }
          if (sql.includes('update public.users set name')) {
            nameFills.push(params as string[]);
            return Promise.resolve({ rows: [], rowCount: 1 });
          }
          // "Reports to": the manager read and the cycle/depth probe.
          if (sql.includes('select m.status, u.disabled')) {
            return Promise.resolve(
              opts.manager
                ? { rows: [opts.manager], rowCount: 1 }
                : { rows: [], rowCount: 0 },
            );
          }
          if (sql.includes('with recursive live')) {
            return Promise.resolve({
              rows: [
                {
                  cycle: opts.managerCycle ?? false,
                  manager_ancestors: opts.managerAncestors ?? 0,
                  subtree_depth: 0,
                },
              ],
              rowCount: 1,
            });
          }
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
          // Removed-membership lookup (reactivation path).
          if (sql.includes('select id from public.memberships')) {
            return opts.removedMembershipId
              ? Promise.resolve({
                  rows: [{ id: opts.removedMembershipId }],
                  rowCount: 1,
                })
              : Promise.resolve({ rows: [], rowCount: 0 });
          }
          if (sql.includes('update public.memberships'))
            return Promise.resolve({
              rows: [{ employee_code: 'EMP-0007' }],
              rowCount: 1,
            });
          if (sql.includes('employee_sequences')) {
            bumps.push(seq);
            return Promise.resolve({
              rows: [{ last_seq: seq++ }],
              rowCount: 1,
            });
          }
          // Employee-code existence check.
          if (sql.includes('tenant_id = $1 and employee_code = $2')) {
            const code = params[1] as string;
            return (opts.takenCodes ?? []).includes(code)
              ? Promise.resolve({ rows: [{ n: 1 }], rowCount: 1 })
              : Promise.resolve({ rows: [], rowCount: 0 });
          }
          if (sql.includes('insert into public.memberships')) {
            membershipInserts.push(params as string[]);
            if (opts.membershipError) {
              const firstPass = membershipInserts.length === 1;
              if (!opts.membershipErrorOnce || firstPass) {
                aborted = true;
                return Promise.reject(
                  Object.assign(
                    new Error('unique violation'),
                    opts.membershipError,
                  ),
                );
              }
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
      );
      return {
        tx: { query },
        bumps,
        membershipInserts,
        nameFills,
        savepoints,
        releases,
        rollbacksToSavepoint,
      };
    }

    // Decision 2 (2026-11-11): a capped invite SMS is reported as refused_cap.
    // The invite is still created and returned.
    it('should return sms_status refused_cap when the cap stopped the invite SMS', async () => {
      supabaseClientFactory.createAdmin.mockReturnValue(
        makeInviteAdmin() as never,
      );
      currentTx = makeInviteTx().tx;
      inviteSmsService.sendInviteSms.mockResolvedValueOnce('refused_cap');

      expect(await service.inviteMember(adminUser, dto)).toEqual({
        invite_id: 'new-person-uuid',
        employee_code: 'EMP-004',
        sms_status: 'refused_cap',
      });
    });

    it('creates the invite in one transaction: locks, minted code, skills, audit (201 path)', async () => {
      const admin = makeInviteAdmin();
      supabaseClientFactory.createAdmin.mockReturnValue(admin as never);
      const world = makeInviteTx();
      currentTx = world.tx;

      expect(await service.inviteMember(adminUser, dto)).toEqual({
        invite_id: 'new-person-uuid',
        employee_code: 'EMP-004',
        // Story 21-1: the template is still the placeholder, so no SMS is sent.
        sms_status: 'not_configured',
      });

      const sqls = world.tx.query.mock.calls.map(([sql]: string[]) => sql);
      // The same xact-scoped locks the old invite_member function held.
      expect(sqls.some((s) => s.includes('pg_advisory_xact_lock'))).toBe(true);
      expect(sqls.some((s) => s.includes('attendance_lock_tenant'))).toBe(true);
      // Story 4.2 — validation runs against the global catalog, not
      // tenant_skills, and only active skills are assignable.
      expect(admin.from).toHaveBeenCalledWith('skills');
      expect(admin.skillCheckEq).toHaveBeenCalledWith('is_active', true);
      // The mint: one counter bump for a fresh number, free code on insert.
      expect(world.bumps).toEqual([4]);
      expect(world.membershipInserts).toEqual([
        [
          'new-person-uuid',
          'tenant-uuid-111',
          'employee',
          'EMP-004',
          adminUser.userId,
          null,
        ],
      ]);
      // Skills attach inside the same transaction.
      expect(sqls.some((s) => s.includes('user_skills'))).toBe(true);
      // Audit after the commit, the employment-save way.
      expect(admin.rpc).toHaveBeenCalledWith(
        'write_audit_row',
        expect.objectContaining({
          p_action: 'member.invite',
          p_tenant_id: 'tenant-uuid-111',
          p_target_user: 'new-person-uuid',
          p_details: {
            role: 'employee',
            reactivated: false,
            employee_code: 'EMP-004',
            manager_id: null,
          },
        }),
      );
    });

    it('stores the "Reports to" manager named on the invite', async () => {
      supabaseClientFactory.createAdmin.mockReturnValue(
        makeInviteAdmin() as never,
      );
      const world = makeInviteTx({
        manager: { status: 'active', disabled: false },
      });
      currentTx = world.tx;

      await service.inviteMember(adminUser, {
        ...dto,
        managerId: '550e8400-e29b-41d4-a716-446655440002',
      });

      expect(world.membershipInserts[0][5]).toBe(
        '550e8400-e29b-41d4-a716-446655440002',
      );
    });

    it('refuses an admin invite that also names a manager — 409 MEMBER_IS_ADMIN', async () => {
      supabaseClientFactory.createAdmin.mockReturnValue(
        makeInviteAdmin() as never,
      );
      const world = makeInviteTx({
        manager: { status: 'active', disabled: false },
      });
      currentTx = world.tx;

      await expect(
        service.inviteMember(adminUser, {
          ...dto,
          role: 'company_admin',
          managerId: '550e8400-e29b-41d4-a716-446655440002',
        }),
      ).rejects.toMatchObject({
        status: 409,
        response: { error_code: 'MEMBER_IS_ADMIN' },
      });
    });

    it('refuses a manager who is not an active member — 422 MANAGER_NOT_ACTIVE', async () => {
      supabaseClientFactory.createAdmin.mockReturnValue(
        makeInviteAdmin() as never,
      );
      const world = makeInviteTx({
        manager: { status: 'invited', disabled: false },
      });
      currentTx = world.tx;

      await expect(
        service.inviteMember(adminUser, {
          ...dto,
          managerId: '550e8400-e29b-41d4-a716-446655440002',
        }),
      ).rejects.toMatchObject({
        status: 422,
        response: { error_code: 'MANAGER_NOT_ACTIVE' },
      });
    });

    it('answers not found for a manager who is not in this company', async () => {
      supabaseClientFactory.createAdmin.mockReturnValue(
        makeInviteAdmin() as never,
      );
      const world = makeInviteTx({ manager: null });
      currentTx = world.tx;

      await expect(
        service.inviteMember(adminUser, {
          ...dto,
          managerId: '550e8400-e29b-41d4-a716-446655440002',
        }),
      ).rejects.toMatchObject({
        status: 404,
        response: { error_code: 'RESOURCE_NOT_FOUND' },
      });
    });

    it('refuses a removed manager the same way as any other inactive one — 422', async () => {
      for (const manager of [
        { status: 'removed', disabled: false },
        { status: 'active', disabled: true },
      ]) {
        supabaseClientFactory.createAdmin.mockReturnValue(
          makeInviteAdmin() as never,
        );
        const world = makeInviteTx({ manager });
        currentTx = world.tx;

        await expect(
          service.inviteMember(adminUser, {
            ...dto,
            managerId: '550e8400-e29b-41d4-a716-446655440002',
          }),
        ).rejects.toMatchObject({
          status: 422,
          response: { error_code: 'MANAGER_NOT_ACTIVE' },
        });
      }
    });

    it('refuses an invite that would make the person report to themselves — 422', async () => {
      supabaseClientFactory.createAdmin.mockReturnValue(
        makeInviteAdmin() as never,
      );
      const world = makeInviteTx({
        manager: { status: 'active', disabled: false },
      });
      currentTx = world.tx;

      await expect(
        service.inviteMember(adminUser, {
          ...dto,
          managerId: 'new-person-uuid',
        }),
      ).rejects.toMatchObject({
        status: 422,
        response: { error_code: 'VALIDATION_ERROR' },
      });
    });

    it('refuses an invite whose manager would close a loop or pass the depth cap', async () => {
      for (const [world, errorCode] of [
        [
          makeInviteTx({
            manager: { status: 'active', disabled: false },
            managerCycle: true,
          }),
          'HIERARCHY_CYCLE',
        ],
        [
          makeInviteTx({
            manager: { status: 'active', disabled: false },
            managerAncestors: 19,
          }),
          'HIERARCHY_DEPTH',
        ],
      ] as const) {
        supabaseClientFactory.createAdmin.mockReturnValue(
          makeInviteAdmin() as never,
        );
        currentTx = world.tx;

        await expect(
          service.inviteMember(adminUser, {
            ...dto,
            managerId: '550e8400-e29b-41d4-a716-446655440002',
          }),
        ).rejects.toMatchObject({
          status: 409,
          response: { error_code: errorCode },
        });
      }
    });

    it('defaults the role to employee when none is sent, and passes an explicit role through', async () => {
      supabaseClientFactory.createAdmin.mockReturnValue(
        makeInviteAdmin() as never,
      );
      const world = makeInviteTx();
      currentTx = world.tx;
      await service.inviteMember(adminUser, dto);
      await service.inviteMember(adminUser, {
        ...dto,
        role: Role.COMPANY_ADMIN,
      });
      expect(world.membershipInserts.map((p) => p[2])).toEqual([
        'employee',
        'company_admin',
      ]);
    });

    it('invites a viewer without skills: no skills lookup, no skill rows', async () => {
      const admin = makeInviteAdmin();
      supabaseClientFactory.createAdmin.mockReturnValue(admin as never);
      const world = makeInviteTx();
      currentTx = world.tx;
      const { skillIds: _skillIds, ...noSkills } = dto;
      void _skillIds;
      await service.inviteMember(adminUser, { ...noSkills, role: Role.VIEWER });
      expect(admin.from).not.toHaveBeenCalled();
      const sqls = world.tx.query.mock.calls.map(([sql]: string[]) => sql);
      expect(sqls.some((s) => s.includes('user_skills'))).toBe(false);
      expect(world.membershipInserts[0][2]).toBe('viewer');
    });

    it('skills are OPTIONAL at invite: missing or empty skillIds are valid, no catalog lookup', async () => {
      const admin = makeInviteAdmin();
      supabaseClientFactory.createAdmin.mockReturnValue(admin as never);
      const world = makeInviteTx();
      currentTx = world.tx;
      const { skillIds: _skillIds, ...noSkills } = dto;
      void _skillIds;
      await service.inviteMember(adminUser, noSkills);
      await service.inviteMember(adminUser, { ...dto, skillIds: [] });
      expect(admin.from).not.toHaveBeenCalled();
      expect(world.membershipInserts).toHaveLength(2);
    });

    it('removes duplicate skill IDs before validating and attaching', async () => {
      const admin = makeInviteAdmin();
      supabaseClientFactory.createAdmin.mockReturnValue(admin as never);
      const world = makeInviteTx();
      currentTx = world.tx;
      await service.inviteMember(adminUser, {
        ...dto,
        skillIds: [SKILL_ID, SKILL_ID],
      });
      expect(admin.skillCheckIn).toHaveBeenCalledWith('id', [SKILL_ID]);
      const skillsCall = world.tx.query.mock.calls.find(([sql]: string[]) =>
        sql.includes('user_skills'),
      );
      expect(skillsCall?.[1]).toEqual(['new-person-uuid', [SKILL_ID]]);
    });

    it('should throw BadRequestException when the caller has no tenantId (company not set up)', async () => {
      const noTenantAdmin: RequestUser = { ...adminUser, tenantId: null };
      await expect(service.inviteMember(noTenantAdmin, dto)).rejects.toThrow(
        BadRequestException,
      );
      expect(supabaseClientFactory.createAdmin).not.toHaveBeenCalled();
      expect(withTransaction).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException when skillIds are not in the global catalog (AC5)', async () => {
      const admin = makeInviteAdmin({ validSkills: [] });
      supabaseClientFactory.createAdmin.mockReturnValue(admin as never);
      await expect(service.inviteMember(adminUser, dto)).rejects.toThrow(
        BadRequestException,
      );
      expect(withTransaction).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException when only some skillIds are valid (AC5 partial)', async () => {
      const dtoWithTwo: InviteMemberDto = {
        ...dto,
        skillIds: [SKILL_ID, '550e8400-e29b-41d4-a716-446655440002'],
      };
      const admin = makeInviteAdmin({ validSkills: [{ id: SKILL_ID }] });
      supabaseClientFactory.createAdmin.mockReturnValue(admin as never);
      await expect(service.inviteMember(adminUser, dtoWithTwo)).rejects.toThrow(
        BadRequestException,
      );
      expect(withTransaction).not.toHaveBeenCalled();
    });

    it('should throw InternalServerErrorException when skill validation DB query fails', async () => {
      supabaseClientFactory.createAdmin.mockReturnValue(
        makeInviteAdmin({
          validSkillsError: {
            code: '42P01',
            message: 'relation does not exist',
          },
        }) as never,
      );
      await expect(service.inviteMember(adminUser, dto)).rejects.toThrow(
        InternalServerErrorException,
      );
      expect(withTransaction).not.toHaveBeenCalled();
    });

    it('refuses a caller who is not an active company_admin of the company (403)', async () => {
      supabaseClientFactory.createAdmin.mockReturnValue(
        makeInviteAdmin() as never,
      );
      currentTx = makeInviteTx({ callerIsAdmin: false }).tx;
      await expect(service.inviteMember(adminUser, dto)).rejects.toMatchObject({
        status: 403,
        response: expect.objectContaining({ error_code: ErrorCode.FORBIDDEN }),
      });
    });

    it('refuses a caller the database has no row for (403)', async () => {
      supabaseClientFactory.createAdmin.mockReturnValue(
        makeInviteAdmin() as never,
      );
      currentTx = makeInviteTx({ callerMissing: true }).tx;
      await expect(service.inviteMember(adminUser, dto)).rejects.toMatchObject({
        status: 403,
        response: expect.objectContaining({ error_code: ErrorCode.FORBIDDEN }),
      });
    });

    it('refuses a disabled caller (403)', async () => {
      supabaseClientFactory.createAdmin.mockReturnValue(
        makeInviteAdmin() as never,
      );
      currentTx = makeInviteTx({ callerDisabled: true }).tx;
      await expect(service.inviteMember(adminUser, dto)).rejects.toMatchObject({
        status: 403,
        response: expect.objectContaining({ error_code: ErrorCode.FORBIDDEN }),
      });
    });

    it('answers 404 RESOURCE_NOT_FOUND when the company does not exist', async () => {
      supabaseClientFactory.createAdmin.mockReturnValue(
        makeInviteAdmin() as never,
      );
      currentTx = makeInviteTx({ tenantMissing: true }).tx;
      await expect(service.inviteMember(adminUser, dto)).rejects.toMatchObject({
        status: 404,
        response: expect.objectContaining({
          error_code: ErrorCode.RESOURCE_NOT_FOUND,
        }),
      });
    });

    it('answers 400 VALIDATION_ERROR for a dial code we do not serve', async () => {
      supabaseClientFactory.createAdmin.mockReturnValue(
        makeInviteAdmin() as never,
      );
      currentTx = makeInviteTx({ countryUnsupported: true }).tx;
      await expect(service.inviteMember(adminUser, dto)).rejects.toMatchObject({
        status: 400,
        response: expect.objectContaining({
          error_code: ErrorCode.VALIDATION_ERROR,
          message: 'Invalid country code',
        }),
      });
    });

    it('should throw ConflictException DUPLICATE_RESOURCE when the person already belongs to another company', async () => {
      supabaseClientFactory.createAdmin.mockReturnValue(
        makeInviteAdmin() as never,
      );
      currentTx = makeInviteTx({ personFound: true, elsewhere: true }).tx;
      await expect(service.inviteMember(adminUser, dto)).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({
          error_code: ErrorCode.DUPLICATE_RESOURCE,
        }),
      });
    });

    it('should throw ConflictException ALREADY_IN_TEAM when the person is already in THIS company', async () => {
      supabaseClientFactory.createAdmin.mockReturnValue(
        makeInviteAdmin() as never,
      );
      currentTx = makeInviteTx({ personFound: true, sameTeam: true }).tx;
      await expect(service.inviteMember(adminUser, dto)).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({
          error_code: ErrorCode.ALREADY_IN_TEAM,
        }),
      });
    });

    it('refuses Fenzit staff with PLATFORM_STAFF_NOT_MEMBER (400)', async () => {
      supabaseClientFactory.createAdmin.mockReturnValue(
        makeInviteAdmin() as never,
      );
      currentTx = makeInviteTx({
        personFound: true,
        personPlatformAdmin: true,
      }).tx;
      await expect(service.inviteMember(adminUser, dto)).rejects.toMatchObject({
        status: 400,
        response: expect.objectContaining({
          error_code: ErrorCode.PLATFORM_STAFF_NOT_MEMBER,
        }),
      });
    });

    it('refuses a disabled person (403)', async () => {
      supabaseClientFactory.createAdmin.mockReturnValue(
        makeInviteAdmin() as never,
      );
      currentTx = makeInviteTx({ personFound: true, personDisabled: true }).tx;
      await expect(service.inviteMember(adminUser, dto)).rejects.toMatchObject({
        status: 403,
        response: expect.objectContaining({ error_code: ErrorCode.FORBIDDEN }),
      });
    });

    // THE INCIDENT, AS A TEST: the counter can sit below codes already in use
    // (fixture seeding and hand-set codes never advance it). The mint steps
    // over taken codes instead of crashing on the unique constraint — which,
    // mislabeled as "already belongs to a company", broke every invite for
    // brand-new numbers (prod incident 2026-11-25).
    it('mints the next FREE code, stepping over the codes a drifted counter lands on', async () => {
      supabaseClientFactory.createAdmin.mockReturnValue(
        makeInviteAdmin() as never,
      );
      const world = makeInviteTx({ takenCodes: ['EMP-004', 'EMP-005'] });
      currentTx = world.tx;

      const result = await service.inviteMember(adminUser, dto);

      expect(world.bumps).toEqual([4, 5, 6]);
      expect(world.membershipInserts[0][3]).toBe('EMP-006');
      expect(result.employee_code).toBe('EMP-006');
    });

    it('renders 4-digit sequences in full — lpad parity (EMP-1000, never truncated to EMP-000)', async () => {
      supabaseClientFactory.createAdmin.mockReturnValue(
        makeInviteAdmin() as never,
      );
      const world = makeInviteTx({ seqStart: 1000 });
      currentTx = world.tx;
      const result = await service.inviteMember(adminUser, dto);
      expect(world.membershipInserts[0][3]).toBe('EMP-1000');
      expect(result.employee_code).toBe('EMP-1000');
    });

    it('re-mints when a hand-set code takes ours between the check and the insert', async () => {
      supabaseClientFactory.createAdmin.mockReturnValue(
        makeInviteAdmin() as never,
      );
      const world = makeInviteTx({
        membershipError: {
          code: '23505',
          constraint: 'memberships_tenant_employee_code_key',
        },
        membershipErrorOnce: true,
      });
      currentTx = world.tx;

      const result = await service.inviteMember(adminUser, dto);

      expect(world.bumps).toEqual([4, 5]);
      expect(world.membershipInserts).toHaveLength(2);
      // The failed first attempt ran under its own savepoint and was rolled
      // back to it — the second bump must not hit an aborted transaction.
      expect(world.savepoints).toHaveLength(2);
      expect(world.rollbacksToSavepoint).toHaveLength(1);
      expect(world.releases).toHaveLength(1);
      expect(result.employee_code).toBe('EMP-005');
    });

    it('gives up honestly after five mint attempts (500, never a duplicate-phone 409)', async () => {
      supabaseClientFactory.createAdmin.mockReturnValue(
        makeInviteAdmin() as never,
      );
      const world = makeInviteTx({
        membershipError: {
          code: '23505',
          constraint: 'memberships_tenant_employee_code_key',
        },
      });
      currentTx = world.tx;

      await expect(service.inviteMember(adminUser, dto)).rejects.toMatchObject({
        status: 500,
        response: expect.objectContaining({
          error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        }),
      });
      // Every attempt was bounded the same way: bump → insert under a fresh
      // savepoint → roll back to it. Five tries, five bumps, no releases.
      expect(world.bumps).toHaveLength(5);
      expect(world.membershipInserts).toHaveLength(5);
      expect(world.savepoints).toHaveLength(5);
      expect(world.rollbacksToSavepoint).toHaveLength(5);
      expect(world.releases).toHaveLength(0);
    });

    // A phone race is impossible under the invite advisory lock — invites are
    // the only writers of person rows — so a users_phone_key violation means
    // an unknown writer or a bug. It gets the honest 500, never the blanket
    // duplicate-phone 409 that shipped the incident.
    it('answers the honest 500 when the person insert itself hits a unique violation', async () => {
      supabaseClientFactory.createAdmin.mockReturnValue(
        makeInviteAdmin() as never,
      );
      currentTx = makeInviteTx({
        userInsertError: { code: '23505', constraint: 'users_phone_key' },
      }).tx;

      await expect(service.inviteMember(adminUser, dto)).rejects.toMatchObject({
        status: 500,
        response: expect.objectContaining({
          error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        }),
      });
    });

    it('lets a platform admin invite without a company_admin membership', async () => {
      supabaseClientFactory.createAdmin.mockReturnValue(
        makeInviteAdmin() as never,
      );
      const world = makeInviteTx({
        callerIsAdmin: false,
        callerPlatformAdmin: true,
      });
      currentTx = world.tx;

      const result = await service.inviteMember(adminUser, dto);

      expect(result.employee_code).toBe('EMP-004');
      expect(world.membershipInserts).toHaveLength(1);
    });

    // A unique violation on a constraint the mint does not retry means an
    // unknown writer or a bug — it gets the honest 500. Mapping ANY 23505 to
    // the duplicate-phone 409 is what shipped the 2026-11-25 incident.
    it('should throw InternalServerErrorException on an unrecognised unique violation (23505)', async () => {
      supabaseClientFactory.createAdmin.mockReturnValue(
        makeInviteAdmin() as never,
      );
      currentTx = makeInviteTx({
        membershipError: { code: '23505', constraint: 'something_else_key' },
      }).tx;
      await expect(service.inviteMember(adminUser, dto)).rejects.toMatchObject({
        status: 500,
        response: expect.objectContaining({
          error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        }),
      });
    });

    it('should throw InternalServerErrorException on an unexpected database error', async () => {
      supabaseClientFactory.createAdmin.mockReturnValue(
        makeInviteAdmin() as never,
      );
      currentTx = makeInviteTx({ membershipError: { code: '42P01' } }).tx;
      await expect(service.inviteMember(adminUser, dto)).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('reactivates a removed member: old code kept, no new mint, audit says reactivated', async () => {
      const admin = makeInviteAdmin();
      supabaseClientFactory.createAdmin.mockReturnValue(admin as never);
      const world = makeInviteTx({
        personFound: true,
        removedMembershipId: 'membership-uuid-9',
      });
      currentTx = world.tx;

      const result = await service.inviteMember(adminUser, dto);

      expect(result).toEqual({
        invite_id: 'person-uuid-1',
        employee_code: 'EMP-0007',
        sms_status: 'not_configured',
      });
      expect(world.bumps).toEqual([]);
      expect(world.membershipInserts).toHaveLength(0);
      const sqls = world.tx.query.mock.calls.map(([sql]: string[]) => sql);
      expect(sqls.some((s) => s.includes('update public.memberships'))).toBe(
        true,
      );
      expect(admin.rpc).toHaveBeenCalledWith(
        'write_audit_row',
        expect.objectContaining({
          p_details: expect.objectContaining({ reactivated: true }),
        }),
      );
    });

    it('stores the manager on the reactivation update, not only on a fresh insert', async () => {
      supabaseClientFactory.createAdmin.mockReturnValue(
        makeInviteAdmin() as never,
      );
      const world = makeInviteTx({
        personFound: true,
        removedMembershipId: 'membership-uuid-9',
        manager: { status: 'active', disabled: false },
      });
      currentTx = world.tx;

      await service.inviteMember(adminUser, {
        ...dto,
        managerId: '550e8400-e29b-41d4-a716-446655440002',
      });

      const update = world.tx.query.mock.calls.find(([sql]: string[]) =>
        sql.includes('update public.memberships'),
      );
      expect(update?.[1]).toEqual([
        'membership-uuid-9',
        'employee',
        adminUser.userId,
        '550e8400-e29b-41d4-a716-446655440002',
      ]);
    });

    it('fills a person with no name from the invite, write-once', async () => {
      supabaseClientFactory.createAdmin.mockReturnValue(
        makeInviteAdmin() as never,
      );
      const world = makeInviteTx({ personFound: true });
      currentTx = world.tx;

      await service.inviteMember(adminUser, dto);

      expect(world.nameFills).toEqual([['person-uuid-1', 'Ravi Kumar']]);
    });

    it('a failed audit entry does not undo the invite (the SMS still goes)', async () => {
      supabaseClientFactory.createAdmin.mockReturnValue(
        makeInviteAdmin({ auditReject: new Error('audit down') }) as never,
      );
      currentTx = makeInviteTx().tx;

      expect(await service.inviteMember(adminUser, dto)).toMatchObject({
        employee_code: 'EMP-004',
      });
      expect(inviteSmsService.sendInviteSms).toHaveBeenCalledTimes(1);
    });

    it('should use createAdmin (service role) for the pre/post-transaction steps', async () => {
      supabaseClientFactory.createAdmin.mockReturnValue(
        makeInviteAdmin() as never,
      );
      currentTx = makeInviteTx().tx;
      await service.inviteMember(adminUser, dto);
      expect(supabaseClientFactory.createAdmin).toHaveBeenCalled();
    });
  });

  describe('verifyOtp — membership at sign-in', () => {
    const userId = '550e8400-e29b-41d4-a716-000000000099';
    const tenantId = 'tenant-uuid-111';

    async function arrangeLiveSession() {
      const otp = '123456';
      const session: OtpSession = {
        countryCode: '+91',
        phoneNumber: '2222222222',
        otpHash: await bcrypt.hash(otp, 10),
        attempts: 0,
        locked: false,
        expiresAt: Date.now() + 300_000,
      };
      otpSessionStore.get.mockResolvedValue(session);
      otpSessionStore.delete.mockResolvedValue(undefined);
      jwtService.signAsync.mockResolvedValueOnce('member-jwt');
      return otp;
    }

    it('should activate an invited membership and return the live tenantId and role', async () => {
      const otp = await arrangeLiveSession();
      const admin = loginAdmin({
        user: userRow({ id: userId, name: 'Ravi Kumar' }),
        membership: {
          tenant_id: tenantId,
          role: 'employee',
          status: 'invited',
        },
      });
      supabaseClientFactory.createAdmin.mockReturnValue(admin as never);

      const result = await service.verifyOtp({
        otpSessionId: 'session-id',
        otpCode: otp,
      });

      expect(result.token).toBe('member-jwt');
      expect(result.user).toEqual({
        userId,
        tenantId,
        role: 'employee',
        name: 'Ravi Kumar',
        platformAdmin: false,
        formerMember: false,
      });
      // Activation targets this person's invited membership only (idempotent guard).
      expect(admin.update).toHaveBeenCalledWith({ status: 'active' });
      expect(admin.activateUserEq).toHaveBeenCalledWith('user_id', userId);
      expect(admin.activateStatusEq).toHaveBeenCalledWith('status', 'invited');
      // Role and tenant stay out of the token.
      expect(jwtService.signAsync).toHaveBeenCalledWith({
        sub: userId,
        typ: 'access',
      });
    });

    it('should fail the sign-in with a 500 when activating the invite fails', async () => {
      const otp = await arrangeLiveSession();
      supabaseClientFactory.createAdmin.mockReturnValue(
        loginAdmin({
          user: userRow({ id: userId }),
          membership: {
            tenant_id: tenantId,
            role: 'employee',
            status: 'invited',
          },
          activateError: { message: 'db down' },
        }) as never,
      );
      await expect(
        service.verifyOtp({ otpSessionId: 'session-id', otpCode: otp }),
      ).rejects.toThrow(InternalServerErrorException);
      expect(otpSessionStore.delete).not.toHaveBeenCalled();
    });

    it('should NOT trigger activation for already active members', async () => {
      const otp = await arrangeLiveSession();
      const admin = loginAdmin({
        user: userRow({ id: userId }),
        membership: {
          tenant_id: tenantId,
          role: 'company_admin',
          status: 'active',
        },
      });
      supabaseClientFactory.createAdmin.mockReturnValue(admin as never);

      const result = await service.verifyOtp({
        otpSessionId: 'session-id',
        otpCode: otp,
      });

      expect(admin.update).not.toHaveBeenCalled();
      expect(result.user).toMatchObject({ tenantId, role: 'company_admin' });
    });

    it('returns a viewer as viewer', async () => {
      const otp = await arrangeLiveSession();
      supabaseClientFactory.createAdmin.mockReturnValue(
        loginAdmin({
          user: userRow({ id: userId }),
          membership: { tenant_id: tenantId, role: 'viewer', status: 'active' },
        }) as never,
      );
      const result = await service.verifyOtp({
        otpSessionId: 'session-id',
        otpCode: otp,
      });
      expect(result.user).toMatchObject({ tenantId, role: 'viewer' });
    });

    it('signs a platform admin in as platform_admin with no tenant and no membership read', async () => {
      const otp = await arrangeLiveSession();
      const admin = loginAdmin({
        user: userRow({ id: userId, platform_admin: true }),
        membership: { tenant_id: tenantId, role: 'employee', status: 'active' },
      });
      supabaseClientFactory.createAdmin.mockReturnValue(admin as never);

      const result = await service.verifyOtp({
        otpSessionId: 'session-id',
        otpCode: otp,
      });

      expect(result.user).toMatchObject({
        tenantId: null,
        role: 'platform_admin',
        platformAdmin: true,
      });
      expect(admin.from).not.toHaveBeenCalledWith('memberships');
    });

    it('refuses a disabled user with the generic INVALID_OTP 401: no token, no activation', async () => {
      const otp = await arrangeLiveSession();
      const admin = loginAdmin({
        user: userRow({ id: userId, disabled: true }),
        membership: {
          tenant_id: tenantId,
          role: 'employee',
          status: 'invited',
        },
      });
      supabaseClientFactory.createAdmin.mockReturnValue(admin as never);

      await expect(
        service.verifyOtp({ otpSessionId: 'session-id', otpCode: otp }),
      ).rejects.toMatchObject({
        status: 401,
        response: expect.objectContaining({
          error_code: 'INVALID_OTP',
          message: 'Invalid OTP code',
        }),
      });
      expect(jwtService.signAsync).not.toHaveBeenCalled();
      expect(admin.update).not.toHaveBeenCalled();
    });

    /** A query that is awaited directly (the removed-membership read has no maybeSingle). */
    function awaitedRead(result: { data: unknown; error: unknown }) {
      const chain: Record<string, unknown> = {};
      chain['select'] = jest.fn(() => chain);
      chain['eq'] = jest.fn(() => chain);
      chain['neq'] = jest.fn(() => chain);
      chain['in'] = jest.fn(() => chain);
      chain['then'] = (resolve: (v: unknown) => void) => resolve(result);
      return chain;
    }

    it('a person whose only membership was removed gets no company and formerMember true, and still signs in', async () => {
      const otp = await arrangeLiveSession();
      const users = queryChain({ data: userRow({ id: userId }), error: null });
      const memberships = [
        queryChain({ data: null, error: null }), // no live membership
        awaitedRead({ data: [{ id: 'm-old' }], error: null }), // one removed row
      ];
      const admin = {
        from: jest.fn((table: string) =>
          table === 'users' ? users : memberships.shift(),
        ),
      };
      supabaseClientFactory.createAdmin.mockReturnValue(admin as never);

      const result = await service.verifyOtp({
        otpSessionId: 'session-id',
        otpCode: otp,
      });

      expect(result.token).toBe('member-jwt');
      expect(result.user).toMatchObject({
        tenantId: null,
        role: null,
        formerMember: true,
      });
    });

    /**
     * A predicate-aware membership read: unlike queryChain/awaitedRead above,
     * it APPLIES the chained `.in('status', [...])` the way PostgREST would —
     * the row returns only when its status is inside the filter list. This is
     * what makes a deactivated member provably invisible to the live read.
     */
    function statusAwareMembershipRead(
      row: {
        tenant_id: string;
        role: string;
        status: string;
      } | null,
    ) {
      const inCalls: Array<[string, string[]]> = [];
      const matches = () =>
        row !== null &&
        inCalls.some(
          ([column, values]) =>
            column === 'status' && values.includes(row.status),
        );
      const chain: Record<string, jest.Mock> = {};
      for (const m of ['select', 'eq', 'neq']) {
        chain[m] = jest.fn(() => chain);
      }
      chain['in'] = jest.fn((column: string, values: string[]) => {
        inCalls.push([column, values]);
        return chain;
      });
      // The live read resolves through maybeSingle.
      chain['maybeSingle'] = jest.fn(() =>
        Promise.resolve({ data: matches() ? row : null, error: null }),
      );
      // The parked fallback read is awaited directly (no maybeSingle).
      chain['then'] = (resolve: (v: unknown) => void) =>
        resolve({ data: matches() ? [{ id: 'm-1' }] : [], error: null });
      return { chain, inCalls };
    }

    it('a deactivated member signs into the no-company state: the live read excludes them, formerMember true', async () => {
      const otp = await arrangeLiveSession();
      const users = queryChain({ data: userRow({ id: userId }), error: null });
      const parkedRow = {
        tenant_id: tenantId,
        role: 'employee',
        status: 'deactivated',
      };
      // The SAME deactivated row feeds both reads; only the filter decides.
      const liveRead = statusAwareMembershipRead(parkedRow);
      const parkedRead = statusAwareMembershipRead(parkedRow);
      const memberships = [liveRead.chain, parkedRead.chain];
      const admin = {
        from: jest.fn((table: string) =>
          table === 'users' ? users : memberships.shift(),
        ),
      };
      supabaseClientFactory.createAdmin.mockReturnValue(admin as never);

      const result = await service.verifyOtp({
        otpSessionId: 'session-id',
        otpCode: otp,
      });

      // The live read only ever invites/activates — a deactivated status can
      // never match it, so the person lands in the parked no-company state.
      expect(liveRead.inCalls).toContainEqual([
        'status',
        ['invited', 'active'],
      ]);
      expect(parkedRead.inCalls).toContainEqual([
        'status',
        ['removed', 'deactivated'],
      ]);
      expect(result.token).toBe('member-jwt');
      expect(result.user).toMatchObject({
        tenantId: null,
        role: null,
        formerMember: true,
      });
    });

    it('the parked fallback read names deactivated in its status filter — a parked person is recognised, not treated as brand-new', async () => {
      const otp = await arrangeLiveSession();
      const users = queryChain({ data: userRow({ id: userId }), error: null });
      const liveRead = statusAwareMembershipRead(null);
      const parkedRead = statusAwareMembershipRead({
        tenant_id: tenantId,
        role: 'employee',
        status: 'deactivated',
      });
      const memberships = [liveRead.chain, parkedRead.chain];
      const admin = {
        from: jest.fn((table: string) =>
          table === 'users' ? users : memberships.shift(),
        ),
      };
      supabaseClientFactory.createAdmin.mockReturnValue(admin as never);

      await service.verifyOtp({
        otpSessionId: 'session-id',
        otpCode: otp,
      });

      expect(parkedRead.inCalls).toContainEqual([
        'status',
        ['removed', 'deactivated'],
      ]);
    });

    it('a failed read of removed memberships is a structured 500 and gives no token', async () => {
      const otp = await arrangeLiveSession();
      const users = queryChain({ data: userRow({ id: userId }), error: null });
      const memberships = [
        queryChain({ data: null, error: null }),
        awaitedRead({ data: null, error: { message: 'boom' } }),
      ];
      const admin = {
        from: jest.fn((table: string) =>
          table === 'users' ? users : memberships.shift(),
        ),
      };
      supabaseClientFactory.createAdmin.mockReturnValue(admin as never);

      await expect(
        service.verifyOtp({ otpSessionId: 'session-id', otpCode: otp }),
      ).rejects.toMatchObject({
        status: 500,
        response: expect.objectContaining({
          error_code: 'INTERNAL_SERVER_ERROR',
        }),
      });
      expect(jwtService.signAsync).not.toHaveBeenCalled();
    });

    it('a failed activation of an invited membership is a structured 500 and gives no token', async () => {
      const otp = await arrangeLiveSession();
      const admin = loginAdmin({
        user: userRow({ id: userId }),
        membership: {
          tenant_id: tenantId,
          role: 'employee',
          status: 'invited',
        },
        activateError: { message: 'write failed' },
      });
      supabaseClientFactory.createAdmin.mockReturnValue(admin as never);

      await expect(
        service.verifyOtp({ otpSessionId: 'session-id', otpCode: otp }),
      ).rejects.toMatchObject({
        status: 500,
        response: expect.objectContaining({
          error_code: 'INTERNAL_SERVER_ERROR',
        }),
      });
      expect(jwtService.signAsync).not.toHaveBeenCalled();
    });

    it('creates an identity-only users row on first sign-in (no role, tenant or status columns)', async () => {
      const otp = await arrangeLiveSession();
      const created = userRow({ id: userId, phone_number: '2222222222' });
      const insertChain = queryChain({ data: created, error: null });
      const insert = jest.fn(() => insertChain);
      const usersRead = queryChain({ data: null, error: null });
      const users = { ...usersRead, insert };
      // The second users read (platform_admin) finds the created row.
      usersRead['maybeSingle']
        .mockResolvedValueOnce({ data: null, error: null })
        .mockResolvedValueOnce({ data: created, error: null });
      const memberships = queryChain({ data: null, error: null });
      supabaseClientFactory.createAdmin.mockReturnValue({
        from: jest.fn((t: string) => (t === 'users' ? users : memberships)),
      } as never);

      const result = await service.verifyOtp({
        otpSessionId: 'session-id',
        otpCode: otp,
      });

      const inserted = (insert.mock.calls[0] as unknown[])[0] as Record<
        string,
        unknown
      >;
      expect(Object.keys(inserted).sort()).toEqual([
        'country_code',
        'id',
        'name',
        'phone_number',
      ]);
      expect(inserted).toMatchObject({
        country_code: '+91',
        phone_number: '2222222222',
        name: null,
      });
      expect(result.user).toMatchObject({ tenantId: null, role: null });
    });
  });

  describe('mintRealtimeToken', () => {
    const user: RequestUser = {
      userId: '550e8400-e29b-41d4-a716-446655440000',
      tenantId: 'tenant-uuid',
      role: Role.COMPANY_ADMIN,
      platformAdmin: false,
      rawJwt: 'login-jwt',
    };

    it('mints the Realtime claim set: sub, role "authenticated", ~1h exp', async () => {
      jwtService.signAsync.mockResolvedValueOnce('realtime-jwt');

      const before = Math.floor(Date.now() / 1000);
      const result = await service.mintRealtimeToken(user);
      const after = Math.floor(Date.now() / 1000);

      expect(result).toEqual({
        token: 'realtime-jwt',
        expiresAt: expect.any(String),
      });

      const claims = jwtService.signAsync.mock.calls[0][0] as {
        sub: string;
        role: string;
        exp: number;
      };
      expect(claims.sub).toBe(user.userId);
      // Realtime requires a claim naming an existing Postgres role (Story 3.1
      // spike) — the login JWT is not a Realtime token and is rejected.
      expect(claims.role).toBe('authenticated');
      // Exactly the TTL, robust to scheduler drift between before/after.
      expect(claims.exp).toBeGreaterThanOrEqual(
        before + REALTIME_TOKEN_TTL_SECONDS,
      );
      expect(claims.exp).toBeLessThanOrEqual(
        after + REALTIME_TOKEN_TTL_SECONDS,
      );
      // The payload carries its own `exp`, so no options object follows it —
      // jsonwebtoken throws when both `exp` and `expiresIn` are present.
      expect(jwtService.signAsync.mock.calls[0][1]).toBeUndefined();
    });

    it('reports expiresAt at the exp claim, as ISO 8601', async () => {
      jwtService.signAsync.mockResolvedValueOnce('realtime-jwt');

      const result = await service.mintRealtimeToken(user);

      const claims = jwtService.signAsync.mock.calls[0][0] as { exp: number };
      expect(new Date(result.expiresAt).getTime()).toBe(claims.exp * 1000);
    });

    it('never carries the login token or tenantId claim', async () => {
      jwtService.signAsync.mockResolvedValueOnce('realtime-jwt');

      await service.mintRealtimeToken(user);

      const claims = jwtService.signAsync.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(Object.keys(claims).sort()).toEqual(['exp', 'role', 'sub']);
    });
  });
});
