import {
  BadRequestException,
  NotFoundException,
  InternalServerErrorException,
  ForbiddenException,
  ConflictException,
  Injectable,
  Logger,
  HttpException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { randomInt } from 'crypto';
import type { PoolClient } from 'pg';
import { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { PgPoolFactory } from '../common/pg/pg-pool.factory';
import { OtpSessionStore, OtpSession } from './otp-session-store';
import { SmsDeliveryProvider, SmsDeliveryError } from './sms-delivery.provider';
import { SMS_TEMPLATES } from '../common/constants/sms-templates';
import { SendOtpDto } from './dto/send-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { SetupCompanyDto } from './dto/setup-company.dto';
import { InviteMemberDto } from './dto/invite-member.dto';
import { ErrorCode } from '../common/enums/error-code.enum';
import { MembershipRole, Role } from '../common/enums/role.enum';
import { ACCESS_TOKEN_TYPE } from '../common/guards/jwt-auth.guard';
import { memberRpcException } from '../common/members/member-rpc-error';
import { assertManagerAssignable } from '../common/members/manager-assignment';
import { seedLeaveCatalog } from '../attendance/leave-catalog.seed';
import { startCompanyValidity } from './tenant-validity';
import {
  InviteSmsService,
  InviteSmsStatus,
} from './invite-sms/invite-sms.service';
import { RequestUser } from '../common/interfaces/request-user.interface';

export interface TenantResponse {
  id: string;
  /** Who set the company up. History only; nothing uses it for access. */
  createdBy: string;
  companyName: string;
  gstin: string | null;
  address: string | null;
  stateCode: string;
  upiVpa: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UserIdentityRow {
  id: string;
  country_code: string;
  phone_number: string;
  name: string | null;
  platform_admin: boolean;
  disabled: boolean;
}

/** The `{ token, user }` body every login endpoint returns. */
export interface LoginResult {
  token: string;
  user: {
    userId: string;
    tenantId: string | null;
    role: Role | null;
    name: string | null;
    platformAdmin: boolean;
    /** True when the person has only removed memberships (no company now). */
    formerMember: boolean;
  };
}

const OTP_TTL_SECONDS = 300;
const OTP_RATE_LIMIT_WINDOW = 600;
const OTP_RATE_LIMIT_MAX = 5;
const OTP_MAX_ATTEMPTS = 5;

/**
 * How many times the invite may step over an employee code that turned out to
 * be taken (the counter is a starting point, never the truth). Each pass
 * advances the counter, so the loop always moves forward; the bound only
 * exists so a pathological counter can never spin a pool connection forever.
 */
const INVITE_CODE_MINT_ATTEMPTS = 5;

/** The stored-procedure mint, in TypeScript: 'EMP-' || lpad(seq, max(3, len)). */
function employeeCodeFor(seq: number): string {
  const digits = String(seq);
  return `EMP-${digits.padStart(Math.max(3, digits.length), '0')}`;
}

/** True when a Postgres error is a unique-violation on the named constraint. */
function isUniqueViolation(err: unknown, constraint: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === '23505' &&
    (err as { constraint?: string }).constraint === constraint
  );
}

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
    private readonly inviteSmsService: InviteSmsService,
    private readonly pgPool: PgPoolFactory,
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
      await this.smsDeliveryProvider.send(e164, SMS_TEMPLATES.OTP_LOGIN, {
        number: otp,
      });
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
    return this.preReleaseMasterEnabled() && otpCode === PRE_RELEASE_MASTER_OTP;
  }

  /**
   * Checks a code against an open OTP session and returns the session. Used
   * by login (verifyOtp) and by the public account-deletion request. A wrong
   * code counts toward the session's lockout. The pre-release master code is
   * accepted only when `allowPreReleaseMaster` is set, so the deletion route
   * can never be opened with it.
   */
  async checkOtpCode(
    otpSessionId: string,
    otpCode: string,
    allowPreReleaseMaster: boolean,
  ): Promise<OtpSession> {
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
      (allowPreReleaseMaster && this.acceptsPreReleaseMasterOtp(otpCode));

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
      await this.otpSessionStore.set(otpSessionId, session, remainingSeconds);
      throw new UnauthorizedException({
        error_code: ErrorCode.INVALID_OTP,
        message: 'Invalid OTP code',
      });
    }

    return session;
  }

  /** Ends an OTP session once its code has been used. */
  async endOtpSession(otpSessionId: string): Promise<void> {
    await this.otpSessionStore.delete(otpSessionId);
  }

  async verifyOtp(dto: VerifyOtpDto): Promise<{
    token: string;
    user: {
      userId: string;
      tenantId: string | null;
      role: Role | null;
      name: string | null;
      platformAdmin: boolean;
      formerMember: boolean;
    };
  }> {
    const { otpSessionId, otpCode } = dto;

    const session = await this.checkOtpCode(otpSessionId, otpCode, true);

    const adminClient = this.supabaseClientFactory.createAdmin();
    const user = await this.findOrCreateUser(
      session.countryCode,
      session.phoneNumber,
      adminClient,
    );

    // A disabled person is refused with the same generic 401 as a bad code,
    // so the response never says why (decision 35).
    if (user.disabled) {
      throw new UnauthorizedException({
        error_code: ErrorCode.INVALID_OTP,
        message: 'Invalid OTP code',
      });
    }

    const access = await this.activateMembership(user.id, adminClient);

    // Identity only: company and role are read from the database on every
    // request, so a removed or changed membership takes effect at once.
    const token = await this.signAccessToken(user.id);

    await this.otpSessionStore.delete(otpSessionId);

    return {
      token,
      user: {
        userId: user.id,
        tenantId: access.tenantId,
        role: access.role,
        name: user.name,
        platformAdmin: user.platform_admin,
        formerMember: access.formerMember,
      },
    };
  }

  /**
   * Finishes a login for an already-verified, non-disabled user (used by the
   * email shortcut login): activates an invited membership, signs the
   * identity-only token and returns the same body as `verifyOtp`.
   */
  async issueLogin(
    user: UserIdentityRow,
    admin: SupabaseClient,
  ): Promise<LoginResult> {
    // A disabled person never gets a token, whichever login route called us.
    // A generic 401 for every route, so it reveals nothing about the account.
    if (user.disabled) {
      throw new UnauthorizedException({
        error_code: ErrorCode.UNAUTHORIZED,
        message: 'We could not sign you in right now.',
      });
    }
    const access = await this.activateMembership(user.id, admin);
    const token = await this.signAccessToken(user.id);
    return {
      token,
      user: {
        userId: user.id,
        tenantId: access.tenantId,
        role: access.role,
        name: user.name,
        platformAdmin: user.platform_admin,
        formerMember: access.formerMember,
      },
    };
  }

  /** The login token. Carries identity and the `typ: 'access'` marker only. */
  private signAccessToken(userId: string): Promise<string> {
    return this.jwtService.signAsync({ sub: userId, typ: ACCESS_TOKEN_TYPE });
  }

  /**
   * First sign-in activates an invited membership (an invite is accepted by
   * signing in). Returns the person's live company and role, or nulls when
   * they have none (new, or only removed memberships). A platform admin has no
   * membership and reads as `platform_admin`.
   */
  private async activateMembership(
    userId: string,
    admin: SupabaseClient,
  ): Promise<{
    tenantId: string | null;
    role: Role | null;
    formerMember: boolean;
  }> {
    const { data: userRow } = await admin
      .from('users')
      .select('platform_admin')
      .eq('id', userId)
      .maybeSingle<{ platform_admin: boolean }>();
    if (userRow?.platform_admin) {
      return { tenantId: null, role: Role.PLATFORM_ADMIN, formerMember: false };
    }

    // The one-live-membership index makes this at most one row. `deactivated`
    // is deliberately NOT live here (parked access): the person signs into the
    // no-company state instead of a session that 403s every call.
    const { data: live, error } = await admin
      .from('memberships')
      .select('tenant_id, role, status')
      .eq('user_id', userId)
      .in('status', ['invited', 'active'])
      .maybeSingle<{
        tenant_id: string;
        role: MembershipRole;
        status: string;
      }>();

    if (error) {
      this.logger.error('Failed to read membership at login:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to sign in',
      });
    }
    if (!live) {
      // No live membership. A removed or deactivated row tells the app to say
      // "no access" rather than walk a brand-new person through company setup.
      const { data: parked, error: parkedError } = await admin
        .from('memberships')
        .select('id')
        .eq('user_id', userId)
        .in('status', ['removed', 'deactivated']);
      if (parkedError) {
        this.logger.error('Failed to read removed membership at login:', {
          error: parkedError,
        });
        throw new InternalServerErrorException({
          error_code: ErrorCode.INTERNAL_SERVER_ERROR,
          message: 'Failed to sign in',
        });
      }
      return {
        tenantId: null,
        role: null,
        formerMember: (parked ?? []).length > 0,
      };
    }

    if (live.status === 'invited') {
      const { error: activateError } = await admin
        .from('memberships')
        .update({ status: 'active' })
        .eq('user_id', userId)
        .eq('status', 'invited'); // idempotent guard — no-op if already activated
      if (activateError) {
        this.logger.error('Failed to activate invited membership:', {
          error: activateError,
        });
        throw new InternalServerErrorException({
          error_code: ErrorCode.INTERNAL_SERVER_ERROR,
          message: 'Failed to sign in',
        });
      }
    }
    return {
      tenantId: live.tenant_id,
      role: live.role,
      formerMember: false,
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

  async inviteMember(
    caller: RequestUser,
    dto: InviteMemberDto,
  ): Promise<{
    invite_id: string;
    employee_code: string;
    sms_status: InviteSmsStatus;
  }> {
    if (!caller.tenantId) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Company setup required before inviting people',
      });
    }

    const tenantId = caller.tenantId;
    const role = dto.role ?? Role.EMPLOYEE;
    // Skills are optional for every role: a technician can be invited with
    // none and get skills later. An empty list is valid for the RPC below.
    const skillIds = [...new Set(dto.skillIds ?? [])];

    const admin = this.supabaseClientFactory.createAdmin();

    // Validate all skillIds exist in the global skills catalog (Story 4.2:
    // skills are developer-seeded platform-wide, no tenant scoping). Only
    // active skills are assignable — the invite payload lists what GET /skills
    // serves.
    if (skillIds.length > 0) {
      const { data: validSkills, error: skillValidationError } = await admin
        .from('skills')
        .select('id')
        .in('id', skillIds)
        .eq('is_active', true);

      if (skillValidationError) {
        this.logger.error('Failed to validate skill IDs:', {
          error: skillValidationError,
        });
        throw new InternalServerErrorException({
          error_code: ErrorCode.INTERNAL_SERVER_ERROR,
          message: 'Failed to validate skill IDs',
        });
      }

      if (!validSkills || validSkills.length !== skillIds.length) {
        throw new BadRequestException({
          error_code: ErrorCode.VALIDATION_ERROR,
          message: 'One or more skill IDs are invalid',
        });
      }
    }

    // The whole invite is one all-or-nothing database step: find or create the
    // person, refuse a person who already belongs to a company, create the
    // membership with its employee code, and attach the skills. This used to
    // be the invite_member PL/pgSQL function; the stored-procedure rule keeps
    // that logic here instead — same locks, same errors, but reviewable and
    // jest-testable (the code-minting had zero test coverage when its counter
    // drift shipped as "This number already belongs to a company", prod
    // incident 2026-11-25).
    let invite: Awaited<ReturnType<AuthService['runInviteTx']>>;
    try {
      invite = await this.pgPool.withTransaction(async (tx) => {
        return this.runInviteTx(tx, caller, dto, tenantId, role, skillIds);
      });
    } catch (txError: unknown) {
      // Nest exceptions ARE the invite's error contract (the app maps their
      // error_code) — pass them through untouched. Anything else is a database
      // failure the invite did not predict: log it and answer the honest 500.
      // Never a duplicate-phone 409: that blanket mapping is what shipped the
      // 2026-11-25 incident.
      if (txError instanceof HttpException) throw txError;
      this.logger.error('Failed to create member invite:', { error: txError });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to create invite',
      });
    }

    // Audit after the commit, the employment-save way: what happened, never
    // the values behind it; a failed audit entry does not undo the invite.
    try {
      const auditCall = (await admin.rpc('write_audit_row', {
        p_actor: caller.userId,
        p_action: 'member.invite',
        p_tenant_id: tenantId,
        p_target_user: invite.membershipUserId,
        p_details: {
          role,
          reactivated: invite.wasReactivated,
          employee_code: invite.employeeCode,
          manager_id: dto.managerId ?? null,
        },
      })) as { error: { code?: string; message?: string } | null };
      if (auditCall.error) {
        this.logger.error('Failed to write the invite audit entry:', {
          error: auditCall.error,
        });
      }
    } catch (auditError: unknown) {
      this.logger.error('Failed to write the invite audit entry:', {
        error: auditError,
      });
    }

    // The invite is already saved. The SMS step never rolls it back and never
    // throws; its outcome is returned as sms_status.
    const smsStatus = await this.inviteSmsService.sendInviteSms({
      tenantId: caller.tenantId,
      membershipUserId: invite.membershipUserId,
      countryCode: dto.countryCode,
      phoneNumber: dto.phoneNumber,
      name: dto.name,
    });
    return {
      invite_id: invite.membershipUserId,
      employee_code: invite.employeeCode,
      // refused_cap: the invite stands, no text went, and Resend answers 429.
      sms_status: smsStatus,
    };
  }

  /**
   * The invite transaction body, extracted so the error contract is one
   * readable page: locks → caller → company → person → membership → skills.
   * The duplicate-person cases throw the exact errors invite_member used to
   * raise (memberRpcException's mapping), so the app copy never changes.
   */
  private async runInviteTx(
    tx: PoolClient,
    caller: RequestUser,
    dto: InviteMemberDto,
    tenantId: string,
    role: MembershipRole,
    skillIds: string[],
  ): Promise<{
    membershipUserId: string;
    employeeCode: string;
    wasReactivated: boolean;
  }> {
    // One invite per phone number at a time, across companies, then the
    // company lock — the exact xact-scoped locks the function held.
    await tx.query(
      `select pg_advisory_xact_lock(hashtext('invite:' || $1 || $2))`,
      [dto.countryCode, dto.phoneNumber],
    );
    await tx.query('select public.attendance_lock_tenant($1, true)', [
      tenantId,
    ]);

    // Caller check under the locks (the function re-checked after waiting for
    // them): a live, enabled person who manages this company — or staff.
    const callerRow = await tx.query<{
      platform_admin: boolean;
      disabled: boolean;
      is_company_admin: boolean;
    }>(
      `select u.platform_admin, u.disabled, exists (
         select 1 from public.memberships m
          where m.user_id = u.id and m.tenant_id = $2
            and m.status = 'active' and m.role = 'company_admin'
       ) as is_company_admin
         from public.users u
        where u.id = $1`,
      [caller.userId, tenantId],
    );
    const callerInfo = callerRow.rows[0];
    if (
      !callerInfo ||
      callerInfo.disabled ||
      (!callerInfo.platform_admin && !callerInfo.is_company_admin)
    ) {
      throw new ForbiddenException({
        error_code: ErrorCode.FORBIDDEN,
        message: 'You do not have permission to do that',
      });
    }

    // The company must exist (404) and the dial code must be one we serve.
    const tenant = await tx.query(
      'select 1 from public.tenants where id = $1',
      [tenantId],
    );
    if (tenant.rowCount === 0) {
      throw new NotFoundException({
        error_code: ErrorCode.RESOURCE_NOT_FOUND,
        message: 'Not found',
      });
    }
    const country = await tx.query(
      'select 1 from public.country_codes where dial_code = $1',
      [dto.countryCode],
    );
    if (country.rowCount === 0) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid country code',
      });
    }

    // Find the person by phone — row-locked for the whole invite, which also
    // serializes against setupCompany (it takes the same users-row lock for
    // the caller), so the "one live membership per person" rule below can
    // never be raced past.
    const name = dto.name.trim();
    const found = (
      await tx.query<{
        id: string;
        name: string | null;
        platform_admin: boolean;
        disabled: boolean;
      }>(
        `select id, name, platform_admin, disabled from public.users
          where country_code = $1 and phone_number = $2
          order by created_at
          limit 1
          for update`,
        [dto.countryCode, dto.phoneNumber],
      )
    ).rows[0];

    let personId: string;
    let personName: string | null;
    if (found) {
      if (found.platform_admin) {
        throw new BadRequestException({
          error_code: ErrorCode.PLATFORM_STAFF_NOT_MEMBER,
          message:
            'This number belongs to Fenzit staff and cannot join a company',
        });
      }
      if (found.disabled) {
        throw new ForbiddenException({
          error_code: ErrorCode.FORBIDDEN,
          message: 'You do not have permission to do that',
        });
      }
      const sameTeam = await tx.query(
        `select 1 from public.memberships
          where user_id = $1 and tenant_id = $2 and status <> 'removed'`,
        [found.id, tenantId],
      );
      if (sameTeam.rowCount !== 0) {
        throw new ConflictException({
          error_code: ErrorCode.ALREADY_IN_TEAM,
          message: 'This person is already in your company',
        });
      }
      const elsewhere = await tx.query(
        `select 1 from public.memberships
          where user_id = $1 and status <> 'removed'`,
        [found.id],
      );
      if (elsewhere.rowCount !== 0) {
        throw new ConflictException({
          error_code: ErrorCode.DUPLICATE_RESOURCE,
          message: 'This person already belongs to a company',
        });
      }
      personId = found.id;
      personName = found.name;
    } else {
      // The phone advisory lock above makes this insert unloseable: invites
      // are the only writers of person rows, and same-phone invites queue on
      // the lock. A users_phone_key violation here would mean an unknown
      // writer exists — that is a bug, so it gets the honest 500, not a
      // duplicate-phone 409 that blames the number.
      const created = await tx.query<{ id: string }>(
        `insert into public.users (name, country_code, phone_number)
         values ($1, $2, $3)
         returning id`,
        [name.length > 0 ? name : null, dto.countryCode, dto.phoneNumber],
      );
      personId = created.rows[0].id;
      personName = null;
    }
    // A person who joined with no name on record gets the invite's name; the
    // guard keeps it write-once (an existing name is never overwritten).
    if (personName === null && name.length > 0) {
      await tx.query(
        'update public.users set name = $2 where id = $1 and name is null',
        [personId, name],
      );
    }

    // "Reports to" is validated inside the invite transaction, under the same
    // company and phone locks, so a manager cannot change underneath it. The
    // guards are PATCH's — an admin invitee can never carry a pointer.
    if (dto.managerId !== undefined) {
      if (role === Role.COMPANY_ADMIN) {
        throw new ConflictException({
          error_code: ErrorCode.MEMBER_IS_ADMIN,
          message:
            'An admin sits at the top of the team and cannot report to anyone',
        });
      }
      await assertManagerAssignable(tx, tenantId, personId, dto.managerId);
    }
    const managerId = dto.managerId ?? null;

    // A previously removed member keeps their code and history: flip the old
    // membership back to invited instead of minting a new one.
    const removed = await tx.query<{ id: string }>(
      `select id from public.memberships
        where user_id = $1 and tenant_id = $2 and status = 'removed'
        for update`,
      [personId, tenantId],
    );
    const oldMembership = removed.rows[0];
    if (oldMembership) {
      const reactivated = await tx.query<{ employee_code: string }>(
        `update public.memberships
            set status = 'invited', role = $2, invited_by = $3, manager_id = $4
          where id = $1 and status = 'removed'
          returning employee_code`,
        [oldMembership.id, role, caller.userId, managerId],
      );
      await this.attachInviteSkills(tx, personId, skillIds);
      return {
        membershipUserId: personId,
        employeeCode: reactivated.rows[0].employee_code,
        wasReactivated: true,
      };
    }

    // Mint the next FREE employee code: the counter is a starting point, never
    // the truth. Codes can be hand-set by the owner (the employment save does
    // not hold the invite locks), so the counter can sit below codes already
    // in use — each pass bumps the counter and checks this company's
    // memberships, stepping over taken codes instead of crashing on them
    // (this exact crash was the 2026-11-25 incident). The counter upsert
    // row-locks per tenant, so concurrent invites stay serial.
    for (let attempt = 0; attempt < INVITE_CODE_MINT_ATTEMPTS; attempt++) {
      const bump = await tx.query<{ last_seq: number }>(
        `insert into public.employee_sequences (tenant_id, last_seq)
         values ($1, 1)
         on conflict (tenant_id)
         do update set last_seq = public.employee_sequences.last_seq + 1
         returning last_seq`,
        [tenantId],
      );
      const code = employeeCodeFor(bump.rows[0].last_seq);
      const taken = await tx.query(
        `select 1 from public.memberships
          where tenant_id = $1 and employee_code = $2`,
        [tenantId, code],
      );
      if (taken.rowCount !== 0) continue;

      // Each attempt runs inside a savepoint: a failed insert aborts the whole
      // transaction on Postgres, so "catch and keep going" only works if the
      // attempt's damage is rolled back to the savepoint first — the 25P02
      // ("current transaction is aborted") on the next bump is otherwise
      // unavoidable. The PL/pgSQL exception block this replaces provided that
      // isolation for free.
      await tx.query('savepoint invite_code_mint');
      try {
        const membership = await tx.query<{ employee_code: string }>(
          `insert into public.memberships (user_id, tenant_id, role, status, employee_code, invited_by, manager_id)
           values ($1, $2, $3, 'invited', $4, $5, $6)
           returning employee_code`,
          [personId, tenantId, role, code, caller.userId, managerId],
        );
        await tx.query('release savepoint invite_code_mint');
        await this.attachInviteSkills(tx, personId, skillIds);
        return {
          membershipUserId: personId,
          employeeCode: membership.rows[0].employee_code,
          wasReactivated: false,
        };
      } catch (err) {
        if (isUniqueViolation(err, 'memberships_tenant_employee_code_key')) {
          // A hand-set code grabbed ours between the check and the insert —
          // undo the aborted attempt and step over it to the next code.
          await tx.query('rollback to savepoint invite_code_mint');
          continue;
        }
        throw err;
      }
    }
    this.logger.error(
      'inviteMember could not mint a free employee code after retries',
      { tenantId },
    );
    throw new InternalServerErrorException({
      error_code: ErrorCode.INTERNAL_SERVER_ERROR,
      message: 'Failed to create invite',
    });
  }

  /** Attach the invited person's skills inside the invite transaction. */
  private async attachInviteSkills(
    tx: PoolClient,
    personId: string,
    skillIds: string[],
  ): Promise<void> {
    if (skillIds.length === 0) return;
    await tx.query(
      `insert into public.user_skills (user_id, skill_id)
       select $1, s from unnest($2::uuid[]) as s
       on conflict do nothing`,
      [personId, skillIds],
    );
  }

  async setupCompany(
    user: RequestUser,
    dto: SetupCompanyDto,
  ): Promise<{ tenant: TenantResponse; created: boolean; token: string }> {
    const admin = this.supabaseClientFactory.createAdmin();

    // Fenzit staff edit the company named in X-Company-Id; they never create one.
    if (user.platformAdmin) {
      return this.updateCompanyAsStaff(user, dto);
    }

    const { data, error } = await admin.rpc('setup_tenant_for_owner', {
      p_user_id: user.userId,
      p_company_name: dto.companyName,
      p_gstin: dto.gstin ?? null,
      p_address: dto.address ?? null,
      p_state_code: dto.stateCode,
      p_upi_vpa: dto.upiVpa ?? null,
    });

    if (error) {
      // 403 for a disabled person (staff are sent to updateCompanyAsStaff above),
      // 409 for a person who already belongs to another company (decisions 28 and 34).
      const mapped = memberRpcException(error);
      if (mapped) throw mapped;
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

    // The FIXED leave catalog (23-13): every company starts with the four
    // types — the migration ensured them for the tenants that predate this,
    // and company setup seeds them here. Idempotent, so a retry after a
    // failed setup heals the rows; a seed failure fails the setup exactly
    // like the validity write below does.
    try {
      await seedLeaveCatalog(admin, row['id'] as string);
    } catch (catalogError: unknown) {
      this.logger.error('Failed to seed the leave catalog:', {
        error: catalogError,
      });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to set up company',
      });
    }

    // New company: subscription runs 90 days from now (CAP-3). A failure here
    // fails the setup; the owner retries and the repeat call sets it.
    try {
      await startCompanyValidity(admin, row['id'] as string);
    } catch (validityError: unknown) {
      this.logger.error('Failed to set the company validity:', {
        error: validityError,
      });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to set up company',
      });
    }

    const tenant: TenantResponse = {
      id: row['id'] as string,
      createdBy: row['created_by'] as string,
      companyName: row['company_name'] as string,
      gstin: (row['gstin'] as string | null) ?? null,
      address: (row['address'] as string | null) ?? null,
      stateCode: row['state_code'] as string,
      upiVpa: (row['upi_vpa'] as string | null) ?? null,
      createdAt: row['created_at'] as string,
      updatedAt: row['updated_at'] as string,
    };

    // Persist the admin's name (collected on the signup profile screen) onto
    // their users row. Optional: clients that don't send it leave
    // `users.name` null. Non-fatal on failure — the tenant was already
    // created, and `/users/me` consumers render a null name gracefully.
    if (dto.name) {
      const { error: nameError } = await admin
        .from('users')
        .update({ name: dto.name })
        .eq('id', user.userId);
      if (nameError) {
        this.logger.warn('Failed to save admin name during company setup:', {
          error: nameError,
        });
      }
    }

    // The login token is identity only; company and role come from the
    // membership just created. A fresh one is returned so existing clients
    // that swap the token after setup keep working.
    const token = await this.signAccessToken(user.userId);

    return { tenant, created: row['inserted'] as boolean, token };
  }

  /** Platform admin path of POST /auth/company: update, never create. */
  private async updateCompanyAsStaff(
    user: RequestUser,
    dto: SetupCompanyDto,
  ): Promise<{ tenant: TenantResponse; created: boolean; token: string }> {
    if (!user.tenantId) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Name the company with the X-Company-Id header',
      });
    }
    // Only the fields sent are changed (same rule as a repeat setup call).
    const changes: Record<string, string> = {
      company_name: dto.companyName,
      state_code: dto.stateCode,
    };
    if (dto.gstin !== undefined) changes.gstin = dto.gstin;
    if (dto.address !== undefined) changes.address = dto.address;
    if (dto.upiVpa !== undefined) changes.upi_vpa = dto.upiVpa;

    const { data, error } = await this.supabaseClientFactory
      .createAdmin()
      .from('tenants')
      .update({ ...changes, updated_at: new Date().toISOString() })
      .eq('id', user.tenantId)
      .select(
        'id, created_by, company_name, gstin, address, state_code, upi_vpa, created_at, updated_at',
      )
      .maybeSingle();
    if (error) {
      this.logger.error('Staff company update failed:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to update the company',
      });
    }
    if (!data) {
      throw new NotFoundException({
        error_code: ErrorCode.RESOURCE_NOT_FOUND,
        message: 'Company not found',
      });
    }
    const tenant: TenantResponse = {
      id: data.id as string,
      createdBy: data.created_by as string,
      companyName: data.company_name as string,
      gstin: (data.gstin as string | null) ?? null,
      address: (data.address as string | null) ?? null,
      stateCode: data.state_code as string,
      upiVpa: (data.upi_vpa as string | null) ?? null,
      createdAt: data.created_at as string,
      updatedAt: data.updated_at as string,
    };
    return {
      tenant,
      created: false,
      token: await this.signAccessToken(user.userId),
    };
  }

  /**
   * The one user row for a phone number (identity only). Creates it on first
   * sign-in. Company and role live on the membership, not here.
   */
  private async findOrCreateUser(
    countryCode: string,
    phoneNumber: string,
    supabaseClient: SupabaseClient,
  ): Promise<UserIdentityRow> {
    const columns =
      'id, country_code, phone_number, name, platform_admin, disabled';
    const { data: existing, error } = await supabaseClient
      .from('users')
      .select(columns)
      .eq('country_code', countryCode)
      .eq('phone_number', phoneNumber)
      .maybeSingle<UserIdentityRow>();

    if (error) {
      this.logger.error('Failed to query user:', { error });
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message:
          'We could not sign you in right now. Please try again in a few minutes.',
      });
    }

    if (existing) {
      return existing;
    }

    const { data: newUser, error: createError } = await supabaseClient
      .from('users')
      .insert({
        id: this.generateUuid(),
        country_code: countryCode,
        phone_number: phoneNumber,
        name: null,
      })
      .select(columns)
      .single<UserIdentityRow>();

    if (createError || !newUser) {
      // A concurrent first login can create the row between our select and
      // this insert (unique violation 23505) — read it back instead of
      // failing the login.
      if (createError?.code === '23505') {
        const { data: racedUser } = await supabaseClient
          .from('users')
          .select(columns)
          .eq('country_code', countryCode)
          .eq('phone_number', phoneNumber)
          .maybeSingle<UserIdentityRow>();
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
        message:
          'We could not sign you in right now. Please try again in a few minutes.',
      });
    }

    return newUser;
  }

  private generateUuid(): string {
    return crypto.randomUUID();
  }
}
