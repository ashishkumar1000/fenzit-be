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
import { randomInt } from 'crypto';
import { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { OtpSessionStore, OtpSession } from './otp-session-store';
import {
  SmsDeliveryProvider,
  SmsDeliveryError,
} from './sms-delivery.provider';
import { SMS_TEMPLATES } from '../common/constants/sms-templates';
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
  upiVpa: string | null;
  createdAt: string;
  updatedAt: string;
}

const OTP_TTL_SECONDS = 300;
const OTP_RATE_LIMIT_WINDOW = 600;
const OTP_RATE_LIMIT_MAX = 5;
const OTP_MAX_ATTEMPTS = 5;

// PRE-RELEASE MASTER OTP (user-directed: 816001 on 2026-10-02, re-keyed to
// 1039 on 2026-10-15 so it fits the 4-digit input): while the pre-SMS-cutover
// dev flag is on, it verifies ANY live session — the release build has no
// __DEV__ chip and DLT SMS is not live, so this is the only way to log in.
// REMOVE AT GO-LIVE: it is gated on OTP_DEV_ECHO, so unsetting that flag for
// the SMS cutover also kills the master code even if this line is missed.
const PRE_RELEASE_MASTER_OTP = '1039';

/**
 * Supabase Realtime tokens are short-lived on purpose — the login JWT is
 * never-expire by design, and Realtime needs a fresh claim set anyway (see
 * `mintRealtimeToken`). One hour keeps the exchange cheap (the client refreshes
 * only near expiry, roughly once an hour of foreground use) while capping how
 * long a leaked copy is usable.
 */
export const REALTIME_TOKEN_TTL_SECONDS = 3600;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly otpSessionStore: OtpSessionStore,
    private readonly smsDeliveryProvider: SmsDeliveryProvider,
    private readonly supabaseClientFactory: SupabaseClientFactory,
    private readonly jwtService: JwtService,
  ) {}

  async sendOtp(
    dto: SendOtpDto,
  ): Promise<{ otp_session_id: string; expires_at: string }> {
    const { countryCode, phoneNumber } = dto;
    const e164 = `${countryCode}${phoneNumber}`;

    const { count: sendCount, windowRemainingSeconds } =
      await this.otpSessionStore.increment(e164, OTP_RATE_LIMIT_WINDOW);

    if (sendCount > OTP_RATE_LIMIT_MAX) {
      throw new HttpException(
        {
          error_code: ErrorCode.RATE_LIMIT_EXCEEDED,
          message: `Too many OTP requests. Maximum ${OTP_RATE_LIMIT_MAX} requests allowed per ${OTP_RATE_LIMIT_WINDOW / 60} minutes.`,
          // GlobalExceptionFilter lifts this into a Retry-After response
          // header (same contract as the places 429s). The value is the time
          // REMAINING in the window, not its full length.
          retryAfterSeconds: windowRemainingSeconds,
        },
        429,
      );
    }

    // CSPRNG, not Math.random() — real verification deserves an
    // unpredictable code (PRD FR-BE6a). 4 digits per the user's product
    // call (2026-10-15); online guessing is bounded by the per-session
    // 5-attempt lockout below, the 5-minute TTL, and the 5-sends/10-min
    // send cap — not by the code space.
    const otp = randomInt(1000, 10000).toString();
    const otpHash = await bcrypt.hash(otp, 10);

    const sessionId = this.generateUuid();
    const expiresAt = Date.now() + OTP_TTL_SECONDS * 1000;
    const session: OtpSession = {
      countryCode,
      phoneNumber,
      otpHash,
      attempts: 0,
      locked: false,
      expiresAt,
    };

    await this.otpSessionStore.set(sessionId, session, OTP_TTL_SECONDS);
    await this.deliverOtp(sessionId, e164, otp);

    // SECURITY: the response NEVER carries the code. The old OTP_DEV_ECHO
    // echo (bug-bash 2026-10-02 F2: an echo on a public endpoint is
    // equivalent to having no OTP factor) is gone — testing rides the
    // flag-gated master code below instead (user call, 2026-10-15).
    return {
      otp_session_id: sessionId,
      expires_at: new Date(expiresAt).toISOString(),
    };
  }

  /**
   * The delivery leg (PRD FR-BE4/FR-BE8). Failure semantics are
   * outcome-specific: a definitive pre-dispatch failure deletes the
   * just-created session (nobody received anything); a TIMEOUT keeps it —
   * MSG91 may already have dispatched and the SMS can still arrive. Either
   * way the endpoint answers 502 OTP_SEND_FAILED, and the rate-limit
   * counter having incremented is accepted (it must not be bypassable via
   * a failing provider). One structured line per attempt feeds the
   * delivery metrics; the plaintext code is NEVER logged here — the mock
   * provider logs it in the environments where that is the fallback.
   */
  private async deliverOtp(
    sessionId: string,
    e164: string,
    otp: string,
  ): Promise<void> {
    const startedAt = Date.now();
    try {
      // `number` is the approved template's single variable slot — the
      // copy reads "Your FENZIT Login OTP is ##number## …" (see
      // SMS_TEMPLATES.OTP_LOGIN).
      await this.smsDeliveryProvider.send(
        e164,
        SMS_TEMPLATES.OTP_LOGIN,
        { number: otp },
      );
      this.logger.log(
        JSON.stringify({
          event: 'otp_delivery',
          phone: e164,
          provider: this.smsDeliveryProvider.constructor.name,
          outcome: 'ok',
          durationMs: Date.now() - startedAt,
        }),
      );
    } catch (err) {
      if (!(err instanceof SmsDeliveryError)) {
        // An unexpected provider crash (a bug, not a gateway answer) still
        // gets its structured line — one otp_delivery event per attempt,
        // every outcome. Rethrown as-is on purpose: it is a 500, and folding
        // it into the retryable 502 contract would misreport who failed.
        this.logger.error(
          JSON.stringify({
            event: 'otp_delivery',
            phone: e164,
            provider: this.smsDeliveryProvider.constructor.name,
            outcome: 'crash',
            durationMs: Date.now() - startedAt,
            detail: err instanceof Error ? err.message : String(err),
          }),
        );
        throw err;
      }
      this.logger.error(
        JSON.stringify({
          event: 'otp_delivery',
          phone: e164,
          provider: this.smsDeliveryProvider.constructor.name,
          outcome: err.outcome,
          durationMs: Date.now() - startedAt,
          vendorType: err.vendorType,
          detail: err.message,
        }),
      );
      if (err.outcome !== 'timeout') {
        // The 502 must reach the client even if the store hiccups — a
        // failing delete is logged, never allowed to mask the delivery
        // failure with a less-specific 500.
        try {
          await this.otpSessionStore.delete(sessionId);
        } catch (deleteErr) {
          this.logger.error(
            JSON.stringify({
              event: 'otp_session_delete_failed',
              sessionId,
              detail:
                deleteErr instanceof Error
                  ? deleteErr.message
                  : String(deleteErr),
            }),
          );
        }
      }
      throw new HttpException(
        {
          error_code: ErrorCode.OTP_SEND_FAILED,
          message:
            'We couldn’t send the code right now. Please try again in a moment.',
        },
        502,
      );
    }
  }

  /** The pre-release master code rides the SAME env flag the old response
   *  echo used (OTP_DEV_ECHO — flipping it for the SMS cutover disables the
   *  master with no code change, see the constant's note). That flag's only
   *  remaining job is this gate. */
  private preReleaseMasterEnabled(): boolean {
    return process.env['OTP_DEV_ECHO']?.trim() === 'true';
  }

  private acceptsPreReleaseMasterOtp(otpCode: string): boolean {
    return (
      this.preReleaseMasterEnabled() && otpCode === PRE_RELEASE_MASTER_OTP
    );
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

    const isValid =
      (await bcrypt.compare(otpCode, session.otpHash)) ||
      this.acceptsPreReleaseMasterOtp(otpCode);

    if (!isValid) {
      session.attempts += 1;
      if (session.attempts >= OTP_MAX_ATTEMPTS) {
        session.locked = true;
      }
      // Hold the session's REMAINING ttl — a fresh window here would let
      // paced wrong guesses extend the session past its advertised
      // expires_at (review EC-1).
      const remainingSeconds = Math.max(
        1,
        Math.ceil((session.expiresAt - Date.now()) / 1000),
      );
      await this.otpSessionStore.set(
        otpSessionId,
        session,
        remainingSeconds,
      );
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

  /**
   * Mints a short-lived token for the Supabase Realtime socket (Story 3.3).
   *
   * Realtime rejects the login JWT — it carries no `exp` and its role claim
   * ('owner'/'technician') is not an existing Postgres role (verified live in
   * Story 3.1's spike) — so the app exchanges its login token for this one:
   * same signing secret, claims `{ sub, role: 'authenticated', exp }`.
   * `role: 'authenticated'` names the Postgres role Realtime requires;
   * authorization itself happens in Realtime's RLS policies, which key on
   * `sub` only (e.g. `realtime.messages` topic policy).
   */
  async mintRealtimeToken(
    user: RequestUser,
  ): Promise<{ token: string; expiresAt: string }> {
    const exp = Math.floor(Date.now() / 1000) + REALTIME_TOKEN_TTL_SECONDS;
    // The payload carries its own `exp`, so NO options object is passed to
    // signAsync — jsonwebtoken throws when both a payload `exp` and an
    // options `expiresIn` are present, and it also auto-adds `iat`. Keep it
    // this way; a `signAsync(claims, { expiresIn: ... })` edit would 500.
    const token = await this.jwtService.signAsync({
      sub: user.userId,
      role: 'authenticated',
      exp,
    });
    return { token, expiresAt: new Date(exp * 1000).toISOString() };
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

    // Validate all skillIds exist in the global skills catalog (Story 4.2:
    // skills are developer-seeded platform-wide, no tenant scoping). Only
    // active skills are assignable — the invite payload lists what GET /skills
    // serves.
    const uniqueSkillIds = [...new Set(dto.skillIds)];
    const { data: validSkills, error: skillValidationError } = await admin
      .from('skills')
      .select('id')
      .in('id', uniqueSkillIds)
      .eq('is_active', true);

    if (skillValidationError) {
      this.logger.error('Failed to validate skill IDs:', {
        error: skillValidationError,
      });
      throw new InternalServerErrorException('Failed to validate skill IDs');
    }

    if (!validSkills || validSkills.length !== uniqueSkillIds.length) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'One or more skill IDs are invalid',
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
      upiVpa: (row['upi_vpa'] as string | null) ?? null,
      createdAt: row['created_at'] as string,
      updatedAt: row['updated_at'] as string,
    };

    // Persist the owner's name (collected on the signup profile screen) onto
    // their users row. Optional: clients that don't send it leave
    // `users.name` null. Non-fatal on failure — the tenant was already
    // created, and `/users/me` consumers render a null name gracefully.
    if (dto.name) {
      const { error: nameError } = await admin
        .from('users')
        .update({ name: dto.name })
        .eq('id', user.userId);
      if (nameError) {
        this.logger.warn('Failed to save owner name during company setup:', {
          error: nameError,
        });
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
    const { data: matchingUsers, error } = await supabaseClient
      .from('users')
      .select('id, country_code, phone_number, name, role, tenant_id, status')
      .eq('country_code', countryCode)
      .eq('phone_number', phoneNumber)
      .order('created_at', { ascending: true });

    if (error) {
      this.logger.error('Failed to query user:', { error });
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'We could not sign you in right now. Please try again in a few minutes.',
      });
    }

    if (matchingUsers && matchingUsers.length > 0) {
      // A phone can have several rows (cross-tenant invites, plus legacy
      // owner stubs created by earlier partial signups). Pick the row that
      // can actually sign in: a real membership (active first, then invited)
      // always beats a tenant-less stub; oldest row breaks remaining ties.
      // `.single()` here treated "multiple rows" as "no rows" and fell into
      // the create path below, minting a new stub on every login (FN-2026-10-03).
      const withTenant = matchingUsers.filter((u) => u.tenant_id !== null);
      const picked =
        withTenant.find((u) => u.status === 'active') ??
        withTenant.find((u) => u.status === 'invited') ??
        withTenant[0] ??
        matchingUsers[0];
      return picked;
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
      // A concurrent first login can create the row between our select and
      // this insert (unique violation 23505) — read it back instead of
      // failing the login.
      if (createError?.code === '23505') {
        const { data: racedUser } = await supabaseClient
          .from('users')
          .select('id, country_code, phone_number, name, role, tenant_id, status')
          .eq('country_code', countryCode)
          .eq('phone_number', phoneNumber)
          .order('created_at', { ascending: true })
          .limit(1)
          .maybeSingle();
        if (racedUser) {
          return racedUser;
        }
      }
      this.logger.error('Failed to create user:', {
        error: createError,
        message: createError?.message,
        details: createError?.details,
      });
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'We could not sign you in right now. Please try again in a few minutes.',
      });
    }

    return newUser;
  }

  private generateUuid(): string {
    return crypto.randomUUID();
  }
}
