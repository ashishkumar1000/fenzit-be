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
import {
  SmsDeliveryProvider,
  SmsDeliveryError,
} from './sms-delivery.provider';
import { SMS_TEMPLATES } from '../common/constants/sms-templates';
import { ErrorCode } from '../common/enums/error-code.enum';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
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
    from: jest.fn((table: string) =>
      table === 'users' ? users : memberships,
    ),
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

describe('AuthService', () => {
  let service: AuthService;
  let otpSessionStore: jest.Mocked<OtpSessionStore>;
  let smsDeliveryProvider: jest.Mocked<SmsDeliveryProvider>;
  let supabaseClientFactory: jest.Mocked<SupabaseClientFactory>;
  let jwtService: jest.Mocked<JwtService>;

  beforeEach(async () => {
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: OtpSessionStore, useValue: mockOtpSessionStore },
        { provide: SmsDeliveryProvider, useValue: mockSmsDeliveryProvider },
        { provide: SupabaseClientFactory, useValue: mockSupabaseClientFactory },
        { provide: JwtService, useValue: mockJwtService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    otpSessionStore = module.get(OtpSessionStore);
    smsDeliveryProvider = module.get(SmsDeliveryProvider);
    supabaseClientFactory = module.get(SupabaseClientFactory);
    jwtService = module.get(JwtService);
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
        const dto: SendOtpDto = { countryCode: '+91', phoneNumber: '1234567890' };
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
      expect(otpSessionStore.delete).toHaveBeenCalledWith(
        expect.any(String),
      );
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
      const mockAdmin = {
        rpc: jest.fn().mockResolvedValue({
          data: [{ ...rpcRow, inserted: true }],
          error: null,
        }),
        from: jest.fn().mockReturnValue({
          insert: jest.fn().mockResolvedValue({ error: null }),
        }),
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
    });

    it('should save the owner name on their users row when provided', async () => {
      const eq = jest.fn().mockResolvedValue({ error: null });
      const update = jest.fn().mockReturnValue({ eq });
      const mockAdmin = {
        rpc: jest.fn().mockResolvedValue({
          data: [{ ...rpcRow, inserted: true }],
          error: null,
        }),
        from: jest.fn().mockReturnValue({ update }),
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
        from: jest.fn().mockReturnValue({
          update: jest.fn().mockReturnValue({ eq }),
        }),
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
        from: jest.fn(),
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

    function makeMockAdmin(opts: {
      validSkills?: { id: string }[];
      validSkillsError?: { code?: string; message?: string } | null;
      rpcResult?: {
        data: unknown;
        error: { code?: string; message?: string; hint?: string } | null;
      };
    }) {
      const validSkillsData =
        opts.validSkills !== undefined ? opts.validSkills : [{ id: SKILL_ID }];

      // Story 4.2 — captured so tests can assert the is_active filter.
      const skillCheckEq = jest.fn().mockResolvedValue({
        data: opts.validSkillsError ? null : validSkillsData,
        error: opts.validSkillsError ?? null,
      });
      const skillCheckIn = jest.fn().mockReturnValue({ eq: skillCheckEq });

      return {
        skillCheckEq,
        skillCheckIn,
        rpc: jest.fn().mockResolvedValue(
          opts.rpcResult ?? {
            data: [
              {
                member_user_id: 'invite-uuid',
                member_employee_code: 'EMP-0001',
              },
            ],
            error: null,
          },
        ),
        from: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnValue({ in: skillCheckIn }),
        }),
      };
    }

    const rpcFails = (code: string, hint?: string) =>
      makeMockAdmin({
        rpcResult: { data: null, error: { code, message: 'x', hint } },
      });

    it('should create an invite through the invite_member function and return invite_id + employee_code (201 path)', async () => {
      const mockAdmin = makeMockAdmin({});
      supabaseClientFactory.createAdmin.mockReturnValue(mockAdmin as never);
      expect(await service.inviteMember(adminUser, dto)).toEqual({
        invite_id: 'invite-uuid',
        employee_code: 'EMP-0001',
      });
      // Story 4.2 — validation runs against the global catalog, not tenant_skills,
      // and only active skills are assignable.
      expect(mockAdmin.from).toHaveBeenCalledWith('skills');
      expect(mockAdmin.skillCheckEq).toHaveBeenCalledWith('is_active', true);
      // The caller and company come from the request user, never the body.
      expect(mockAdmin.rpc).toHaveBeenCalledWith('invite_member', {
        p_caller: adminUser.userId,
        p_tenant_id: 'tenant-uuid-111',
        p_country_code: '+91',
        p_phone_number: '1111111111',
        p_name: 'Ravi Kumar',
        p_role: Role.EMPLOYEE,
        p_skill_ids: [SKILL_ID],
      });
    });

    it('defaults the role to employee when none is sent, and passes an explicit role through', async () => {
      const mockAdmin = makeMockAdmin({});
      supabaseClientFactory.createAdmin.mockReturnValue(mockAdmin as never);
      await service.inviteMember(adminUser, dto);
      expect(mockAdmin.rpc.mock.calls[0][1]).toMatchObject({
        p_role: 'employee',
      });

      await service.inviteMember(adminUser, {
        ...dto,
        role: Role.COMPANY_ADMIN,
      });
      expect(mockAdmin.rpc.mock.calls[1][1]).toMatchObject({
        p_role: 'company_admin',
      });
    });

    it('invites a viewer without skills: no skills lookup, empty p_skill_ids', async () => {
      const mockAdmin = makeMockAdmin({});
      supabaseClientFactory.createAdmin.mockReturnValue(mockAdmin as never);
      const { skillIds: _skillIds, ...noSkills } = dto;
      void _skillIds;
      await service.inviteMember(adminUser, { ...noSkills, role: Role.VIEWER });
      expect(mockAdmin.from).not.toHaveBeenCalled();
      expect(mockAdmin.rpc.mock.calls[0][1]).toMatchObject({
        p_role: 'viewer',
        p_skill_ids: [],
      });
    });

    it('rejects an employee with no skills (missing or empty) with 422 before any database call', async () => {
      const mockAdmin = makeMockAdmin({});
      supabaseClientFactory.createAdmin.mockReturnValue(mockAdmin as never);
      const { skillIds: _skillIds, ...noSkills } = dto;
      void _skillIds;
      for (const candidate of [noSkills, { ...dto, skillIds: [] }]) {
        await expect(
          service.inviteMember(adminUser, candidate),
        ).rejects.toMatchObject({ status: 422 });
      }
      expect(mockAdmin.rpc).not.toHaveBeenCalled();
    });

    it('removes duplicate skill IDs before validating and sending', async () => {
      const mockAdmin = makeMockAdmin({});
      supabaseClientFactory.createAdmin.mockReturnValue(mockAdmin as never);
      await service.inviteMember(adminUser, {
        ...dto,
        skillIds: [SKILL_ID, SKILL_ID],
      });
      expect(mockAdmin.skillCheckIn).toHaveBeenCalledWith('id', [SKILL_ID]);
      expect(mockAdmin.rpc.mock.calls[0][1]).toMatchObject({
        p_skill_ids: [SKILL_ID],
      });
    });

    it('should throw BadRequestException when the caller has no tenantId (company not set up)', async () => {
      const noTenantAdmin: RequestUser = { ...adminUser, tenantId: null };
      await expect(
        service.inviteMember(noTenantAdmin, dto),
      ).rejects.toThrow(BadRequestException);
      expect(supabaseClientFactory.createAdmin).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException when skillIds are not in the global catalog (AC5)', async () => {
      const mockAdmin = makeMockAdmin({ validSkills: [] });
      supabaseClientFactory.createAdmin.mockReturnValue(mockAdmin as never);
      await expect(service.inviteMember(adminUser, dto)).rejects.toThrow(
        BadRequestException,
      );
      expect(mockAdmin.rpc).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException when only some skillIds are valid (AC5 partial)', async () => {
      const dtoWithTwo: InviteMemberDto = {
        ...dto,
        skillIds: [SKILL_ID, '550e8400-e29b-41d4-a716-446655440002'],
      };
      const mockAdmin = makeMockAdmin({ validSkills: [{ id: SKILL_ID }] });
      supabaseClientFactory.createAdmin.mockReturnValue(mockAdmin as never);
      await expect(
        service.inviteMember(adminUser, dtoWithTwo),
      ).rejects.toThrow(BadRequestException);
      expect(mockAdmin.rpc).not.toHaveBeenCalled();
    });

    it('should throw InternalServerErrorException when skill validation DB query fails', async () => {
      supabaseClientFactory.createAdmin.mockReturnValue(
        makeMockAdmin({
          validSkillsError: {
            code: '42P01',
            message: 'relation does not exist',
          },
        }) as never,
      );
      await expect(service.inviteMember(adminUser, dto)).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('maps PT403 to 403, PT404 to 404 and PT400 to 400', async () => {
      supabaseClientFactory.createAdmin.mockReturnValue(
        rpcFails('PT403') as never,
      );
      await expect(service.inviteMember(adminUser, dto)).rejects.toThrow(
        ForbiddenException,
      );
      supabaseClientFactory.createAdmin.mockReturnValue(
        rpcFails('PT404') as never,
      );
      await expect(service.inviteMember(adminUser, dto)).rejects.toThrow(
        NotFoundException,
      );
      supabaseClientFactory.createAdmin.mockReturnValue(
        rpcFails('PT400') as never,
      );
      await expect(service.inviteMember(adminUser, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw ConflictException DUPLICATE_RESOURCE when the person already belongs to a company (PT409)', async () => {
      supabaseClientFactory.createAdmin.mockReturnValue(
        rpcFails('PT409') as never,
      );
      await expect(service.inviteMember(adminUser, dto)).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({
          error_code: ErrorCode.DUPLICATE_RESOURCE,
        }),
      });
    });

    it('maps a PT409 carrying the LAST_ADMIN hint to the LAST_ADMIN code', async () => {
      supabaseClientFactory.createAdmin.mockReturnValue(
        rpcFails('PT409', ErrorCode.LAST_ADMIN) as never,
      );
      await expect(service.inviteMember(adminUser, dto)).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({
          error_code: ErrorCode.LAST_ADMIN,
        }),
      });
    });

    it('should throw BadRequestException on invalid country code FK violation (23503)', async () => {
      supabaseClientFactory.createAdmin.mockReturnValue(
        rpcFails('23503') as never,
      );
      await expect(service.inviteMember(adminUser, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw ConflictException on a concurrent duplicate invite (23505)', async () => {
      supabaseClientFactory.createAdmin.mockReturnValue(
        rpcFails('23505') as never,
      );
      await expect(service.inviteMember(adminUser, dto)).rejects.toThrow(
        ConflictException,
      );
    });

    it('should throw InternalServerErrorException on an unexpected database error', async () => {
      supabaseClientFactory.createAdmin.mockReturnValue(
        rpcFails('42P01') as never,
      );
      await expect(service.inviteMember(adminUser, dto)).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('should throw InternalServerErrorException when the function returns no row', async () => {
      for (const data of [[], null]) {
        supabaseClientFactory.createAdmin.mockReturnValue(
          makeMockAdmin({ rpcResult: { data, error: null } }) as never,
        );
        await expect(service.inviteMember(adminUser, dto)).rejects.toThrow(
          InternalServerErrorException,
        );
      }
    });

    it('should use createAdmin (service role) for the invite', async () => {
      supabaseClientFactory.createAdmin.mockReturnValue(
        makeMockAdmin({}) as never,
      );
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
        membership: { tenant_id: tenantId, role: 'employee', status: 'invited' },
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
          membership: { tenant_id: tenantId, role: 'employee', status: 'invited' },
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
        membership: { tenant_id: tenantId, role: 'employee', status: 'invited' },
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
        membership: { tenant_id: tenantId, role: 'employee', status: 'invited' },
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
