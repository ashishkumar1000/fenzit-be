import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { VerifyOtpDto } from '../auth/dto/verify-otp.dto';
import { ErrorCode } from '../common/enums/error-code.enum';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import type { RequestUser } from '../common/interfaces/request-user.interface';

/**
 * The same answer whether or not an account matches the number, so the page
 * never reveals who has a Fenzit account.
 */
export const DELETION_RECEIVED_MESSAGE =
  'Thanks. We have received your request. Our team will review it. Some job and attendance records that your company needs may stay, with your name removed.';

const UNIQUE_VIOLATION = '23505';

/**
 * Files a deletion request for the account that owns a phone number. The
 * person must prove they hold the number with a one-time code first. Nothing
 * here deletes anything: a platform admin reviews the open request.
 */
@Injectable()
export class AccountDeletionService {
  private readonly logger = new Logger(AccountDeletionService.name);

  constructor(
    private readonly authService: AuthService,
    private readonly supabaseClientFactory: SupabaseClientFactory,
  ) {}

  async request(dto: VerifyOtpDto): Promise<string> {
    // The master code is never accepted here (see checkOtpCode).
    const session = await this.authService.checkOtpCode(
      dto.otpSessionId,
      dto.otpCode,
      false,
    );
    await this.authService.endOtpSession(dto.otpSessionId);

    const admin = this.supabaseClientFactory.createAdmin();
    const { data: user, error: userError } = await admin
      .from('users')
      .select('id')
      .eq('country_code', session.countryCode)
      .eq('phone_number', session.phoneNumber)
      .maybeSingle<{ id: string }>();

    if (userError) {
      // Never log the phone number: it is personal data.
      this.logger.error(
        `Failed to look up user for deletion (code=${userError.code ?? 'none'})`,
      );
      throw this.internal();
    }

    if (user) {
      await this.fileDeletionRequest(user.id, 'web');
    }

    return DELETION_RECEIVED_MESSAGE;
  }

  /**
   * Files a deletion request for the signed-in account — the in-app path.
   * The JWT is the identity proof (RequestUser is built from the database,
   * never from a client-supplied number), so no OTP round-trip is needed;
   * the public web flow keeps its code check. Same review afterwards, and
   * the same one-open-request-per-user idempotency.
   */
  async requestForSignedIn(user: RequestUser): Promise<string> {
    await this.fileDeletionRequest(user.userId, 'app');
    return DELETION_RECEIVED_MESSAGE;
  }

  /**
   * The one insert both filing paths share (public and in-app). A second
   * request while one is open is the same answer, not an error
   * (account_deletion_requests_one_open_per_user). Nothing deletes here: a
   * platform admin reviews the open request. `source` records which surface
   * filed it (the admin queue shows it).
   */
  private async fileDeletionRequest(
    userId: string,
    source: 'web' | 'app',
  ): Promise<void> {
    const admin = this.supabaseClientFactory.createAdmin();
    const { error } = await admin
      .from('account_deletion_requests')
      .insert({ user_id: userId, source });
    if (error && error.code !== UNIQUE_VIOLATION) {
      // Never log personal data: the source label is the only context.
      this.logger.error(
        `Failed to store ${source} deletion request (code=${error.code ?? 'none'})`,
      );
      throw this.internal();
    }
  }

  private internal(): InternalServerErrorException {
    return new InternalServerErrorException({
      error_code: ErrorCode.INTERNAL_SERVER_ERROR,
      message: 'We could not save your request. Please try again.',
    });
  }
}
