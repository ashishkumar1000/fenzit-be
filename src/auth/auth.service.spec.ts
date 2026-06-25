import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  UnauthorizedException,
  HttpException,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { OtpSessionStore, OtpSession } from './otp-session-store';
import { OtpDeliveryProvider } from './otp-delivery.provider';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import { SendOtpDto } from './dto/send-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { SetupCompanyDto } from './dto/setup-company.dto';
import { InviteTechnicianDto } from './dto/invite-technician.dto';
import * as bcrypt from 'bcrypt';

describe('AuthService', () => {
  let service: AuthService;
  let otpSessionStore: jest.Mocked<OtpSessionStore>;
  let otpDeliveryProvider: jest.Mocked<OtpDeliveryProvider>;
  let supabaseClientFactory: jest.Mocked<SupabaseClientFactory>;
  let jwtService: jest.Mocked<JwtService>;

  beforeEach(async () => {
    const mockOtpSessionStore = {
      set: jest.fn(),
      get: jest.fn(),
      delete: jest.fn(),
      increment: jest.fn(),
    };

    const mockOtpDeliveryProvider = {
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
        { provide: OtpDeliveryProvider, useValue: mockOtpDeliveryProvider },
        { provide: SupabaseClientFactory, useValue: mockSupabaseClientFactory },
        { provide: JwtService, useValue: mockJwtService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    otpSessionStore = module.get(OtpSessionStore);
    otpDeliveryProvider = module.get(OtpDeliveryProvider);
    supabaseClientFactory = module.get(SupabaseClientFactory);
    jwtService = module.get(JwtService);
  });

  describe('sendOtp', () => {
    it('should send OTP for valid phone parts', async () => {
      const dto: SendOtpDto = { countryCode: '+91', phoneNumber: '1234567890' };
      otpSessionStore.increment.mockResolvedValue(1);
      otpDeliveryProvider.send.mockResolvedValue(undefined);
      otpSessionStore.set.mockResolvedValue(undefined);

      const result = await service.sendOtp(dto);

      expect(result).toHaveProperty('otp_session_id');
      expect(result).toHaveProperty('expires_at');
      expect(otpSessionStore.increment).toHaveBeenCalledWith(
        '+911234567890',
        600,
      );
      expect(otpDeliveryProvider.send).toHaveBeenCalledWith(
        '+911234567890',
        expect.stringMatching(/^\d{6}$/),
      );
    });

    it('should store countryCode and phoneNumber separately in the session', async () => {
      const dto: SendOtpDto = { countryCode: '+91', phoneNumber: '9876543210' };
      otpSessionStore.increment.mockResolvedValue(1);
      otpDeliveryProvider.send.mockResolvedValue(undefined);
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

    it('should throw rate limit error after 5 sends', async () => {
      const dto: SendOtpDto = { countryCode: '+91', phoneNumber: '1234567890' };
      otpSessionStore.increment.mockResolvedValue(6);

      await expect(service.sendOtp(dto)).rejects.toThrow(HttpException);
    });
  });

  describe('verifyOtp', () => {
    /** Returns a single-call from() mock for findOrCreateUser (select → eq → eq → single) */
    function mockFindUser(user: object) {
      return {
        from: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                single: jest.fn().mockResolvedValueOnce({ data: user }),
              }),
            }),
          }),
        }),
      };
    }

    it('should verify OTP and issue JWT for valid code', async () => {
      const otp = '123456';
      const otpHash = await bcrypt.hash(otp, 10);
      const session: OtpSession = {
        countryCode: '+91',
        phoneNumber: '1234567890',
        otpHash,
        attempts: 0,
        locked: false,
      };

      const userId = '550e8400-e29b-41d4-a716-446655440000';
      const mockUser = {
        id: userId,
        country_code: '+91',
        phone_number: '1234567890',
        name: null,
        role: 'owner',
        tenant_id: null,
        status: 'active',
      };

      otpSessionStore.get.mockResolvedValue(session);
      jwtService.signAsync.mockResolvedValueOnce('final-jwt');
      otpSessionStore.delete.mockResolvedValue(undefined);
      supabaseClientFactory.createAdmin.mockReturnValue(
        mockFindUser(mockUser) as never,
      );

      const result = await service.verifyOtp({
        otpSessionId: 'session-id',
        otpCode: otp,
      });

      expect(result).toHaveProperty('token', 'final-jwt');
      expect(result.user).toMatchObject({
        userId,
        tenantId: null,
        role: 'owner',
        name: null,
      });
      expect(otpSessionStore.delete).toHaveBeenCalled();
    });

    it('should accept any 6-digit code in mock mode', async () => {
      const otp = '123456';
      const otpHash = await bcrypt.hash(otp, 10);
      const session: OtpSession = {
        countryCode: '+91',
        phoneNumber: '1234567890',
        otpHash,
        attempts: 0,
        locked: false,
      };

      const mockUser = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        country_code: '+91',
        phone_number: '1234567890',
        name: null,
        role: 'owner',
        tenant_id: null,
        status: 'active',
      };

      otpSessionStore.get.mockResolvedValue(session);
      jwtService.signAsync.mockResolvedValueOnce('final-jwt');
      otpSessionStore.delete.mockResolvedValue(undefined);
      supabaseClientFactory.createAdmin.mockReturnValue(
        mockFindUser(mockUser) as never,
      );

      const result = await service.verifyOtp({
        otpSessionId: 'session-id',
        otpCode: '999999',
      });
      expect(result.token).toBe('final-jwt');
    });

    it('should throw error if session is locked', async () => {
      const session: OtpSession = {
        countryCode: '+91',
        phoneNumber: '1234567890',
        otpHash: await bcrypt.hash('123456', 10),
        attempts: 5,
        locked: true,
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
      role: Role.OWNER,
      rawJwt: 'mock-jwt',
    };

    const dto: SetupCompanyDto = {
      companyName: 'Jobzo Services',
      stateCode: 'KA',
      gstin: '29ABCDE1234F1Z5',
      serviceCategories: ['ac_technician'],
    };

    const rpcRow = {
      id: 'tenant-uuid',
      owner_id: ownerUser.userId,
      company_name: 'Jobzo Services',
      gstin: '29ABCDE1234F1Z5',
      address: null,
      state_code: 'KA',
      service_categories: ['ac_technician'],
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
          upsert: jest.fn().mockResolvedValue({ error: null }),
        }),
      };
      supabaseClientFactory.createAdmin.mockReturnValue(mockAdmin as never);
      jwtService.signAsync.mockResolvedValueOnce('fresh-owner-jwt');

      const result = await service.setupCompany(ownerUser, dto);

      expect(result.created).toBe(true);
      expect(result.token).toBe('fresh-owner-jwt');
      expect(result.tenant).toMatchObject({
        id: 'tenant-uuid',
        ownerId: ownerUser.userId,
        companyName: 'Jobzo Services',
      });
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
          upsert: jest.fn().mockResolvedValue({ error: null }),
        }),
      };
      supabaseClientFactory.createAdmin.mockReturnValue(mockAdmin as never);

      await service.setupCompany(ownerUser, minimalDto);

      expect(mockAdmin.rpc).toHaveBeenCalledWith(
        'setup_tenant_for_owner',
        expect.objectContaining({
          p_gstin: null,
          p_address: null,
          p_service_categories: [],
          p_upi_vpa: null,
        }),
      );
    });

    it('should seed tenant_skills when created=true and serviceCategories provided', async () => {
      const dtoWithCategories: SetupCompanyDto = {
        companyName: 'ACME',
        stateCode: 'MH',
        serviceCategories: ['AC Technician', 'Plumber'],
      };
      const upsertFn = jest.fn().mockResolvedValue({ error: null });
      const mockAdmin = {
        rpc: jest.fn().mockResolvedValue({
          data: [{ ...rpcRow, inserted: true }],
          error: null,
        }),
        from: jest.fn().mockReturnValue({ upsert: upsertFn }),
      };
      supabaseClientFactory.createAdmin.mockReturnValue(mockAdmin as never);
      jwtService.signAsync.mockResolvedValueOnce('fresh-jwt');

      await service.setupCompany(ownerUser, dtoWithCategories);

      expect(mockAdmin.from).toHaveBeenCalledWith('tenant_skills');
      expect(upsertFn).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'ac technician',
            tenant_id: 'tenant-uuid',
          }),
          expect.objectContaining({
            name: 'plumber',
            tenant_id: 'tenant-uuid',
          }),
        ]),
        expect.objectContaining({ ignoreDuplicates: true }),
      );
    });

    it('should NOT seed tenant_skills when created=false (idempotent re-call)', async () => {
      const dtoWithCategories: SetupCompanyDto = {
        companyName: 'ACME',
        stateCode: 'MH',
        serviceCategories: ['AC Technician'],
      };
      const mockAdmin = {
        rpc: jest.fn().mockResolvedValue({
          data: [{ ...rpcRow, inserted: false }],
          error: null,
        }),
        from: jest.fn(),
      };
      supabaseClientFactory.createAdmin.mockReturnValue(mockAdmin as never);
      jwtService.signAsync.mockResolvedValueOnce('fresh-jwt');

      await service.setupCompany(ownerUser, dtoWithCategories);

      expect(mockAdmin.from).not.toHaveBeenCalled();
    });
  });

  describe('inviteTechnician', () => {
    const ownerUser: RequestUser = {
      userId: '550e8400-e29b-41d4-a716-446655440000',
      tenantId: 'tenant-uuid-111',
      role: Role.OWNER,
      rawJwt: 'mock-jwt',
    };

    const SKILL_ID = '550e8400-e29b-41d4-a716-446655440001';

    const dto: InviteTechnicianDto = {
      countryCode: '+91',
      phoneNumber: '1111111111',
      name: 'Ravi Kumar',
      skillIds: [SKILL_ID],
    };

    function makeMockAdmin(opts: {
      existingActive?: { id: string; status: string } | null;
      validSkills?: { id: string }[];
      validSkillsError?: { code?: string; message?: string } | null;
      insertResult?: {
        data: { id: string } | null;
        error: { code?: string; message?: string } | null;
      };
      userSkillsError?: { code?: string; message?: string } | null;
    }) {
      const maybeSingleFn = jest
        .fn()
        .mockResolvedValue({ data: opts.existingActive ?? null, error: null });
      const singleInsertFn = jest
        .fn()
        .mockResolvedValue(
          opts.insertResult ?? { data: { id: 'invite-uuid' }, error: null },
        );
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
                  eq: jest.fn().mockResolvedValue({
                    data: opts.validSkillsError ? null : validSkillsData,
                    error: opts.validSkillsError ?? null,
                  }),
                }),
              }),
            };
          } else if (fromCallCount === 3) {
            // user INSERT
            return {
              insert: jest.fn().mockReturnValue({
                select: jest.fn().mockReturnValue({
                  single: singleInsertFn,
                }),
              }),
            };
          } else if (fromCallCount === 4) {
            // user_skills INSERT
            return {
              insert: jest
                .fn()
                .mockResolvedValue({ error: opts.userSkillsError ?? null }),
            };
          } else {
            // compensating delete on user_skills failure
            return {
              delete: jest.fn().mockReturnValue({
                eq: jest.fn().mockResolvedValue({ error: null }),
              }),
            };
          }
        }),
      };
    }

    it('should create an invite and return invite_id (201 path)', async () => {
      supabaseClientFactory.createAdmin.mockReturnValue(
        makeMockAdmin({}) as never,
      );
      expect(await service.inviteTechnician(ownerUser, dto)).toEqual({
        invite_id: 'invite-uuid',
      });
    });

    it('should throw BadRequestException when owner has no tenantId (company not set up)', async () => {
      const noTenantOwner: RequestUser = { ...ownerUser, tenantId: null };
      await expect(
        service.inviteTechnician(noTenantOwner, dto),
      ).rejects.toThrow(BadRequestException);
      expect(supabaseClientFactory.createAdmin).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException when skillIds do not belong to tenant (AC5)', async () => {
      supabaseClientFactory.createAdmin.mockReturnValue(
        makeMockAdmin({ validSkills: [] }) as never,
      );
      await expect(service.inviteTechnician(ownerUser, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException when only some skillIds are valid (AC5 partial)', async () => {
      const dtoWithTwo: InviteTechnicianDto = {
        ...dto,
        skillIds: [SKILL_ID, '550e8400-e29b-41d4-a716-446655440002'],
      };
      supabaseClientFactory.createAdmin.mockReturnValue(
        makeMockAdmin({ validSkills: [{ id: SKILL_ID }] }) as never,
      );
      await expect(
        service.inviteTechnician(ownerUser, dtoWithTwo),
      ).rejects.toThrow(BadRequestException);
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
      await expect(service.inviteTechnician(ownerUser, dto)).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('should throw BadRequestException on invalid country code FK violation (23503)', async () => {
      supabaseClientFactory.createAdmin.mockReturnValue(
        makeMockAdmin({
          insertResult: {
            data: null,
            error: { code: '23503', message: 'fk constraint' },
          },
        }) as never,
      );
      await expect(service.inviteTechnician(ownerUser, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw ConflictException when phone is already active in tenant (409 path)', async () => {
      supabaseClientFactory.createAdmin.mockReturnValue(
        makeMockAdmin({
          existingActive: { id: 'existing-user-id', status: 'active' },
        }) as never,
      );
      await expect(service.inviteTechnician(ownerUser, dto)).rejects.toThrow(
        ConflictException,
      );
    });

    it('should throw ConflictException on unique phone constraint violation (23505)', async () => {
      supabaseClientFactory.createAdmin.mockReturnValue(
        makeMockAdmin({
          insertResult: {
            data: null,
            error: { code: '23505', message: 'duplicate key' },
          },
        }) as never,
      );
      await expect(service.inviteTechnician(ownerUser, dto)).rejects.toThrow(
        ConflictException,
      );
    });

    it('should throw InternalServerErrorException on unexpected DB error during user INSERT', async () => {
      supabaseClientFactory.createAdmin.mockReturnValue(
        makeMockAdmin({
          insertResult: {
            data: null,
            error: { code: '42P01', message: 'relation does not exist' },
          },
        }) as never,
      );
      await expect(service.inviteTechnician(ownerUser, dto)).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('should throw InternalServerErrorException when user_skills INSERT fails', async () => {
      supabaseClientFactory.createAdmin.mockReturnValue(
        makeMockAdmin({
          userSkillsError: {
            code: '23503',
            message: 'fk constraint on user_skills',
          },
        }) as never,
      );
      await expect(service.inviteTechnician(ownerUser, dto)).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('should use createAdmin (service role) for the invite insert', async () => {
      supabaseClientFactory.createAdmin.mockReturnValue(
        makeMockAdmin({}) as never,
      );
      await service.inviteTechnician(ownerUser, dto);
      expect(supabaseClientFactory.createAdmin).toHaveBeenCalled();
    });
  });

  describe('verifyOtp — auto-accept for invited technician', () => {
    const invitedUserId = '550e8400-e29b-41d4-a716-000000000099';
    const tenantId = 'tenant-uuid-111';

    const invitedUser = {
      id: invitedUserId,
      country_code: '+91',
      phone_number: '2222222222',
      name: 'Ravi Kumar',
      role: 'technician',
      tenant_id: tenantId,
      status: 'invited',
    };

    const activatedUser = { ...invitedUser, status: 'active' };

    it('should activate an invited user and issue JWT with correct tenantId and role', async () => {
      const otp = '123456';
      const otpHash = await bcrypt.hash(otp, 10);
      const session: OtpSession = {
        countryCode: '+91',
        phoneNumber: '2222222222',
        otpHash,
        attempts: 0,
        locked: false,
      };

      otpSessionStore.get.mockResolvedValue(session);
      otpSessionStore.delete.mockResolvedValue(undefined);
      jwtService.signAsync.mockResolvedValueOnce('technician-jwt');

      const updateSingleFn = jest
        .fn()
        .mockResolvedValue({ data: activatedUser, error: null });

      const mockAdmin = {
        from: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                single: jest.fn().mockResolvedValueOnce({ data: invitedUser }),
              }),
            }),
          }),
          update: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                // .eq('status', 'invited') idempotency guard
                select: jest.fn().mockReturnValue({
                  single: updateSingleFn,
                }),
              }),
            }),
          }),
        }),
      };

      supabaseClientFactory.createAdmin.mockReturnValue(mockAdmin as never);

      const result = await service.verifyOtp({
        otpSessionId: 'session-id',
        otpCode: otp,
      });

      expect(result.token).toBe('technician-jwt');
      expect(result.user.tenantId).toBe(tenantId);
      expect(result.user.role).toBe('technician');
      expect(updateSingleFn).toHaveBeenCalled();
    });

    it('should NOT trigger auto-accept for already active users', async () => {
      const otp = '123456';
      const otpHash = await bcrypt.hash(otp, 10);
      const session: OtpSession = {
        countryCode: '+91',
        phoneNumber: '2222222222',
        otpHash,
        attempts: 0,
        locked: false,
      };

      otpSessionStore.get.mockResolvedValue(session);
      otpSessionStore.delete.mockResolvedValue(undefined);
      jwtService.signAsync.mockResolvedValueOnce('owner-jwt');

      const activeUser = {
        id: invitedUserId,
        country_code: '+91',
        phone_number: '2222222222',
        name: null,
        role: 'owner',
        tenant_id: null,
        status: 'active',
      };

      const updateFn = jest.fn();
      const mockAdmin = {
        from: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                single: jest.fn().mockResolvedValueOnce({ data: activeUser }),
              }),
            }),
          }),
          update: updateFn,
        }),
      };

      supabaseClientFactory.createAdmin.mockReturnValue(mockAdmin as never);

      await service.verifyOtp({ otpSessionId: 'session-id', otpCode: otp });
      expect(updateFn).not.toHaveBeenCalled();
    });
  });
});
