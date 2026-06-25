import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  Injectable,
  Logger,
  HttpException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { OtpSessionStore, OtpSession } from './otp-session-store';
import { OtpDeliveryProvider } from './otp-delivery.provider';
import { SendOtpDto } from './dto/send-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { SetupCompanyDto } from './dto/setup-company.dto';
import { InviteTechnicianDto } from './dto/invite-technician.dto';
import { ErrorCode } from '../common/enums/error-code.enum';
import { Role } from '../common/enums/role.enum';
import { RequestUser } from '../common/interfaces/request-user.interface';

export interface TenantResponse {
  id: string;
  ownerId: string;
  companyName: string;
  gstin: string | null;
  address: string | null;
  stateCode: string;
  serviceCategories: string[];
  upiVpa: string | null;
  createdAt: string;
  updatedAt: string;
}

const OTP_TTL_SECONDS = 300;
const OTP_RATE_LIMIT_WINDOW = 600;
const OTP_RATE_LIMIT_MAX = 5;
const OTP_MAX_ATTEMPTS = 5;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly otpSessionStore: OtpSessionStore,
    private readonly otpDeliveryProvider: OtpDeliveryProvider,
    private readonly supabaseClientFactory: SupabaseClientFactory,
    private readonly jwtService: JwtService,
  ) {}

  async sendOtp(
    dto: SendOtpDto,
  ): Promise<{ otp_session_id: string; expires_at: string }> {
    const { countryCode, phoneNumber } = dto;
    const e164 = `${countryCode}${phoneNumber}`;

    const sendCount = await this.otpSessionStore.increment(
      e164,
      OTP_RATE_LIMIT_WINDOW,
    );

    if (sendCount > OTP_RATE_LIMIT_MAX) {
      throw new HttpException(
        {
          error_code: ErrorCode.RATE_LIMIT_EXCEEDED,
          message: `Too many OTP requests. Maximum ${OTP_RATE_LIMIT_MAX} requests allowed per ${OTP_RATE_LIMIT_WINDOW / 60} minutes.`,
        },
        429,
      );
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpHash = await bcrypt.hash(otp, 10);

    const sessionId = this.generateUuid();
    const session: OtpSession = {
      countryCode,
      phoneNumber,
      otpHash,
      attempts: 0,
      locked: false,
    };

    await this.otpSessionStore.set(sessionId, session, OTP_TTL_SECONDS);
    await this.otpDeliveryProvider.send(e164, otp);

    const expiresAt = new Date(
      Date.now() + OTP_TTL_SECONDS * 1000,
    ).toISOString();

    return {
      otp_session_id: sessionId,
      expires_at: expiresAt,
    };
  }

  async verifyOtp(dto: VerifyOtpDto): Promise<{
    token: string;
    user: {
      userId: string;
      tenantId: string | null;
      role: string;
      name: string | null;
    };
  }> {
    const { otpSessionId, otpCode } = dto;

    const session = await this.otpSessionStore.get(otpSessionId);

    if (!session) {
      throw new UnauthorizedException({
        error_code: ErrorCode.OTP_EXPIRED,
        message: 'OTP session not found or expired',
      });
    }

    if (session.locked) {
      throw new UnauthorizedException({
        error_code: ErrorCode.OTP_SESSION_LOCKED,
        message: 'OTP session is locked due to too many failed attempts',
      });
    }

    // Phase 2: replace with `await bcrypt.compare(otpCode, session.otpHash)`
    const isValid = true;

    if (!isValid) {
      session.attempts += 1;
      if (session.attempts >= OTP_MAX_ATTEMPTS) {
        session.locked = true;
      }
      await this.otpSessionStore.set(otpSessionId, session, OTP_TTL_SECONDS);
      throw new UnauthorizedException({
        error_code: ErrorCode.INVALID_OTP,
        message: 'Invalid OTP code',
      });
    }

    const adminClient = this.supabaseClientFactory.createAdmin();
    let user = await this.findOrCreateUser(
      session.countryCode,
      session.phoneNumber,
      adminClient,
    );

    // Auto-accept: invited technician's first OTP login activates their account
    if (user.status === 'invited') {
      const { data: activatedUser, error: updateError } = await adminClient
        .from('users')
        .update({ status: 'active', updated_at: new Date().toISOString() })
        .eq('id', user.id)
        .eq('status', 'invited') // idempotent guard — no-op if already activated
        .select('id, country_code, phone_number, name, role, tenant_id, status')
        .single();

      if (updateError || !activatedUser) {
        this.logger.error('Failed to activate invited user:', {
          error: updateError,
        });
        throw new InternalServerErrorException(
          'Failed to activate invited user',
        );
      }
      user = activatedUser;
    }

    const token = await this.jwtService.signAsync({
      sub: user.id,
      tenantId: user.tenant_id ?? null,
      role: user.role,
    });

    await this.otpSessionStore.delete(otpSessionId);

    return {
      token,
      user: {
        userId: user.id,
        tenantId: user.tenant_id ?? null,
        role: user.role,
        name: user.name,
      },
    };
  }

  async inviteTechnician(
    owner: RequestUser,
    dto: InviteTechnicianDto,
  ): Promise<{ invite_id: string }> {
    if (!owner.tenantId) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Company setup required before inviting technicians',
      });
    }

    const admin = this.supabaseClientFactory.createAdmin();

    // Check for existing active member in this tenant with the same phone
    const { data: existing } = await admin
      .from('users')
      .select('id, status')
      .eq('country_code', dto.countryCode)
      .eq('phone_number', dto.phoneNumber)
      .eq('tenant_id', owner.tenantId)
      .eq('status', 'active')
      .maybeSingle();

    if (existing) {
      throw new ConflictException({
        error_code: ErrorCode.DUPLICATE_RESOURCE,
        message: 'Phone number is already an active member of this tenant',
      });
    }

    // Validate all skillIds belong to this tenant
    const uniqueSkillIds = [...new Set(dto.skillIds)];
    const { data: validSkills, error: skillValidationError } = await admin
      .from('tenant_skills')
      .select('id')
      .in('id', uniqueSkillIds)
      .eq('tenant_id', owner.tenantId);

    if (skillValidationError) {
      this.logger.error('Failed to validate skill IDs:', {
        error: skillValidationError,
      });
      throw new InternalServerErrorException('Failed to validate skill IDs');
    }

    if (!validSkills || validSkills.length !== uniqueSkillIds.length) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message:
          'One or more skill IDs are invalid or do not belong to your tenant',
      });
    }

    const { data: newUser, error } = await admin
      .from('users')
      .insert({
        id: this.generateUuid(),
        country_code: dto.countryCode,
        phone_number: dto.phoneNumber,
        name: dto.name,
        role: Role.TECHNICIAN,
        status: 'invited',
        tenant_id: owner.tenantId,
      })
      .select('id')
      .single();

    if (error) {
      if (error.code === '23505') {
        throw new ConflictException({
          error_code: ErrorCode.DUPLICATE_RESOURCE,
          message: 'This phone number is already registered in this tenant',
        });
      }
      if (error.code === '23503') {
        throw new BadRequestException({
          error_code: ErrorCode.VALIDATION_ERROR,
          message: 'Invalid country code',
        });
      }
      this.logger.error('Failed to create technician invite:', { error });
      throw new InternalServerErrorException('Failed to create invite');
    }

    const { error: skillsError } = await admin.from('user_skills').insert(
      uniqueSkillIds.map((skillId) => ({
        user_id: newUser.id,
        skill_id: skillId,
      })),
    );

    if (skillsError) {
      this.logger.error('Failed to insert user_skills:', {
        error: skillsError,
      });
      // Compensating delete — avoid orphaned invited user with no skills
      await admin.from('users').delete().eq('id', newUser.id);
      throw new InternalServerErrorException(
        'Failed to assign skills to technician',
      );
    }

    return { invite_id: newUser.id };
  }

  async setupCompany(
    user: RequestUser,
    dto: SetupCompanyDto,
  ): Promise<{ tenant: TenantResponse; created: boolean; token: string }> {
    const admin = this.supabaseClientFactory.createAdmin();

    const { data, error } = await admin.rpc('setup_tenant_for_owner', {
      p_user_id: user.userId,
      p_company_name: dto.companyName,
      p_gstin: dto.gstin ?? null,
      p_address: dto.address ?? null,
      p_state_code: dto.stateCode,
      p_service_categories: dto.serviceCategories ?? [],
      p_upi_vpa: dto.upiVpa ?? null,
    });

    if (error) {
      this.logger.error('setup_tenant_for_owner RPC failed:', { error });
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Failed to set up company',
      });
    }

    const rows = data as Array<Record<string, unknown>> | null;
    if (!rows || rows.length === 0) {
      this.logger.error('setup_tenant_for_owner returned no rows');
      throw new InternalServerErrorException(
        'Company setup failed unexpectedly',
      );
    }

    const row = rows[0];
    const tenant: TenantResponse = {
      id: row['id'] as string,
      ownerId: row['owner_id'] as string,
      companyName: row['company_name'] as string,
      gstin: (row['gstin'] as string | null) ?? null,
      address: (row['address'] as string | null) ?? null,
      stateCode: row['state_code'] as string,
      serviceCategories: (row['service_categories'] as string[]) ?? [],
      upiVpa: (row['upi_vpa'] as string | null) ?? null,
      createdAt: row['created_at'] as string,
      updatedAt: row['updated_at'] as string,
    };

    // Auto-seed tenant_skills from serviceCategories on first company creation
    if ((row['inserted'] as boolean) && dto.serviceCategories?.length) {
      const admin2 = this.supabaseClientFactory.createAdmin();
      const { error: seedError } = await admin2.from('tenant_skills').upsert(
        dto.serviceCategories.map((name) => ({
          id: crypto.randomUUID(),
          tenant_id: tenant.id,
          name: name.toLowerCase(),
        })),
        { onConflict: 'tenant_id,lower(name)', ignoreDuplicates: true },
      );
      if (seedError) {
        this.logger.warn(
          'Failed to seed tenant_skills from serviceCategories:',
          { error: seedError },
        );
      }
    }

    const token = await this.jwtService.signAsync({
      sub: user.userId,
      tenantId: tenant.id,
      role: Role.OWNER,
    });

    return { tenant, created: row['inserted'] as boolean, token };
  }

  private async findOrCreateUser(
    countryCode: string,
    phoneNumber: string,
    supabaseClient: SupabaseClient,
  ): Promise<{
    id: string;
    country_code: string;
    phone_number: string;
    name: string | null;
    role: string;
    tenant_id: string | null;
    status: string;
  }> {
    const { data: existingUser, error } = await supabaseClient
      .from('users')
      .select('id, country_code, phone_number, name, role, tenant_id, status')
      .eq('country_code', countryCode)
      .eq('phone_number', phoneNumber)
      .single();

    if (existingUser) {
      return existingUser;
    }

    // PGRST116 = no rows returned — expected for a new phone number
    if (error && error.code !== 'PGRST116') {
      this.logger.error('Failed to query user:', { error });
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Failed to query user',
      });
    }

    const newUserId = this.generateUuid();
    const { data: newUser, error: createError } = await supabaseClient
      .from('users')
      .insert({
        id: newUserId,
        country_code: countryCode,
        phone_number: phoneNumber,
        role: Role.OWNER,
        status: 'active',
        name: null,
        tenant_id: null,
      })
      .select('id, country_code, phone_number, name, role, tenant_id, status')
      .single();

    if (createError || !newUser) {
      this.logger.error('Failed to create user:', {
        error: createError,
        message: createError?.message,
        details: createError?.details,
      });
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Failed to create user',
      });
    }

    return newUser;
  }

  private generateUuid(): string {
    return crypto.randomUUID();
  }
}
