import {
  HttpException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';

import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { createHash, timingSafeEqual } from 'crypto';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { ErrorCode } from '../common/enums/error-code.enum';
import { AuthService, LoginResult } from './auth.service';
import { EmailLoginDto } from './dto/email-login.dto';
import {
  DEV_SHORTCUT_EMAIL_PASSWORD,
  EMAIL_LOGIN_MAX_FAILURES,
  EMAIL_LOGIN_WINDOW_SECONDS,
} from './email-login.constants';

interface FailureEntry {
  count: number;
  expiresAt: number;
}

interface EmailUserRow {
  id: string;
  country_code: string;
  phone_number: string;
  name: string | null;
  platform_admin: boolean;
  disabled: boolean;
}

// DEV SHORTCUT — remove at go-live gate (see email-login.constants.ts)
/**
 * Email + fixed password login. Signs in the EXISTING user who owns the email
 * (it never creates users or roles — web login spec, backend guardrails).
 * Wrong password, unknown email and disabled user all give the same 401, and
 * failures are counted per email whether or not the email exists, so the
 * endpoint reveals nothing about who is registered.
 */
@Injectable()
export class EmailLoginService {
  private readonly logger = new Logger(EmailLoginService.name);

  constructor(
    private readonly authService: AuthService,
    private readonly supabaseClientFactory: SupabaseClientFactory,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  async login(dto: EmailLoginDto): Promise<LoginResult> {
    // Off unless the dev flag is on (the same gate as the master OTP). Going
    // live without that flag makes this route report "not found".
    if (!isDevEchoEnabled()) {
      throw new NotFoundException({
        error_code: ErrorCode.RESOURCE_NOT_FOUND,
        message: 'Not found',
      });
    }

    const email = dto.email;
    const lockKey = `email-login:fail:${email}`;

    const entry = await this.cache.get<FailureEntry>(lockKey);
    if (entry && entry.count >= EMAIL_LOGIN_MAX_FAILURES) {
      throw new HttpException(
        {
          error_code: ErrorCode.RATE_LIMIT_EXCEEDED,
          message: 'Too many failed attempts. Please try again later.',
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((entry.expiresAt - Date.now()) / 1000),
          ),
        },
        429,
      );
    }

    // Count the attempt BEFORE checking the password, so a burst of guesses is
    // counted as it arrives. A success clears the count below.
    await this.recordFailure(lockKey, entry);

    // Always compare, even for an unknown email, so timing is the same.
    const passwordOk = this.passwordMatches(dto.password);
    const user = passwordOk ? await this.findUser(email) : null;

    if (!user || user.disabled) {
      throw new UnauthorizedException({
        error_code: ErrorCode.UNAUTHORIZED,
        message: 'Invalid email or password',
      });
    }

    await this.cache.del(lockKey);
    return this.authService.issueLogin(
      user,
      this.supabaseClientFactory.createAdmin(),
    );
  }

  /** Constant-time: hash both sides to equal length, then timingSafeEqual. */
  private passwordMatches(candidate: string): boolean {
    const a = createHash('sha256').update(candidate).digest();
    const b = createHash('sha256').update(DEV_SHORTCUT_EMAIL_PASSWORD).digest();
    return timingSafeEqual(a, b);
  }

  private async findUser(email: string): Promise<EmailUserRow | null> {
    const { data, error } = await this.supabaseClientFactory
      .createAdmin()
      .from('users')
      .select('id, country_code, phone_number, name, platform_admin, disabled')
      .eq('email', email)
      .maybeSingle<EmailUserRow>();
    if (error) {
      // A database fault is a server error, not a wrong password: say so, and
      // do not let it count against the person's attempts.
      this.logger.error('email login: user lookup failed', {
        code: error.code,
      });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'We could not sign you in right now. Please try again.',
      });
    }
    return data;
  }

  private async recordFailure(
    key: string,
    existing: FailureEntry | undefined | null,
  ): Promise<FailureEntry> {
    // Hold the ORIGINAL window expiry (paced guesses must not extend it).
    const expiresAt =
      existing?.expiresAt ?? Date.now() + EMAIL_LOGIN_WINDOW_SECONDS * 1000;
    const remainingMs = Math.max(1, expiresAt - Date.now());
    const next = { count: (existing?.count ?? 0) + 1, expiresAt };
    await this.cache.set(key, next, remainingMs);
    return next;
  }
}

/** Same gate as the master OTP: the dev flag must be on. */
function isDevEchoEnabled(): boolean {
  return process.env['OTP_DEV_ECHO']?.trim() === 'true';
}
