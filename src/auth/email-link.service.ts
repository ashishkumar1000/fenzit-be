import {
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { ErrorCode } from '../common/enums/error-code.enum';

const PG_UNIQUE_VIOLATION = '23505';
const PG_CHECK_VIOLATION = '23514';

/** "Already taken" answers allowed per signed-in user inside the window, before the endpoint pauses them. */
export const EMAIL_LINK_MAX_TAKEN_ANSWERS = 5;
/** Window for the taken-answer count, in seconds. */
export const EMAIL_LINK_WINDOW_SECONDS = 600;

interface TakenEntry {
  count: number;
  expiresAt: number;
}

/**
 * Links an email address to the signed-in user (web login spec). The email is
 * an extra way to sign in; phone stays required. Linking is allowed for any
 * signed-in person, with or without a company. The user ID always comes from
 * the verified token, never from the request body.
 *
 * Rules:
 *  - Setting the email the account already has is a no-op that returns 200.
 *  - An account that already has a different email cannot change it here (409).
 *  - When the address belongs to another account, the answer is 409. Each
 *    user may get that answer a few times per window; after that the endpoint
 *    answers 429, so it cannot be used to test many addresses.
 */
@Injectable()
export class EmailLinkService {
  private readonly logger = new Logger(EmailLinkService.name);

  constructor(
    private readonly supabaseClientFactory: SupabaseClientFactory,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  async link(userId: string, email: string): Promise<{ email: string }> {
    await this.assertNotPaused(userId);
    const admin = this.supabaseClientFactory.createAdmin();

    const { data: current, error: readError } = await admin
      .from('users')
      .select('email')
      .eq('id', userId)
      .maybeSingle<{ email: string | null }>();
    if (readError) {
      throw this.serverError(readError, userId);
    }
    if (!current) {
      throw new NotFoundException({
        error_code: ErrorCode.RESOURCE_NOT_FOUND,
        message: 'Not found',
      });
    }
    if (current.email === email) {
      return { email };
    }
    if (current.email !== null) {
      throw new ConflictException({
        error_code: ErrorCode.DUPLICATE_RESOURCE,
        message: 'This account already has an email linked.',
      });
    }

    // Only set the email while it is still empty, so two requests cannot overwrite each other.
    const { data, error } = await admin
      .from('users')
      .update({ email })
      .eq('id', userId)
      .is('email', null)
      .select('email')
      .maybeSingle<{ email: string | null }>();

    if (error) {
      const code = (error as { code?: string }).code;
      if (code === PG_UNIQUE_VIOLATION) {
        await this.recordTakenAnswer(userId);
        throw new ConflictException({
          error_code: ErrorCode.DUPLICATE_RESOURCE,
          message: 'That email is already linked to another account.',
        });
      }
      // Only the email format rule means "not a valid address". Any other check failure is a server fault.
      if (code === PG_CHECK_VIOLATION && error.message.includes('users_email_format')) {
        throw new UnprocessableEntityException({
          error_code: ErrorCode.VALIDATION_ERROR,
          message: 'Enter a valid email address.',
        });
      }
      throw this.serverError(error, userId);
    }

    // No row changed: the email was set by a parallel request in the meantime.
    if (!data || !data.email) {
      throw new ConflictException({
        error_code: ErrorCode.DUPLICATE_RESOURCE,
        message: 'This account already has an email linked.',
      });
    }

    return { email: data.email };
  }

  private async assertNotPaused(userId: string): Promise<void> {
    const entry = await this.cache.get<TakenEntry>(this.takenKey(userId));
    if (entry && entry.count >= EMAIL_LINK_MAX_TAKEN_ANSWERS) {
      throw new HttpException(
        {
          error_code: ErrorCode.RATE_LIMIT_EXCEEDED,
          message: 'Too many attempts. Please try again later.',
          retryAfterSeconds: Math.max(1, Math.ceil((entry.expiresAt - Date.now()) / 1000)),
        },
        429,
      );
    }
  }

  private async recordTakenAnswer(userId: string): Promise<void> {
    const key = this.takenKey(userId);
    const existing = await this.cache.get<TakenEntry>(key);
    // Keep the window's original end, so paced probing cannot extend the pause.
    const expiresAt = existing?.expiresAt ?? Date.now() + EMAIL_LINK_WINDOW_SECONDS * 1000;
    const next: TakenEntry = { count: (existing?.count ?? 0) + 1, expiresAt };
    await this.cache.set(key, next, Math.max(1, expiresAt - Date.now()));
  }

  private takenKey(userId: string): string {
    return `email-link:taken:${userId}`;
  }

  /** The email itself is never logged: it is personal data. */
  private serverError(error: unknown, userId: string): InternalServerErrorException {
    this.logger.error('email link: database call failed', {
      code: (error as { code?: string }).code,
      userId,
    });
    return new InternalServerErrorException({
      error_code: ErrorCode.INTERNAL_SERVER_ERROR,
      message: 'We could not save your email right now. Please try again.',
    });
  }
}
