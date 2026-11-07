import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { PgPoolFactory } from '../common/pg/pg-pool.factory';
import { ErrorCode } from '../common/enums/error-code.enum';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import type { RegisterDeviceTokenDto } from './dto/register-device-token.dto';

/**
 * The device_tokens store (CAP-1). Direct pg (the PgModule pool), not
 * supabase-js: the push sweep's claim query (FOR UPDATE SKIP LOCKED) can
 * only be expressed in raw SQL, so the table's one access surface keeps
 * one access style. Every statement is parameterised; callers never
 * interpolate — and never log a full token (it is a server-side
 * credential; log a prefix at most).
 *
 * Identity rule (frozen): the user id comes from RequestUser — built by
 * JwtAuthGuard from the DATABASE, never from the request body — so a
 * caller can only register/delete rows of their own session's user.
 */
@Injectable()
export class DeviceTokensService {
  private readonly logger = new Logger(DeviceTokensService.name);

  constructor(private readonly pg: PgPoolFactory) {}

  /**
   * Idempotent upsert on the token PK: a StrictMode double-post or a
   * signed-in app start re-announcing itself is the same 204. A SHARED
   * PHONE rebinds here — user B registering over user A's row wins the
   * token (last JWT wins), and B's register also clears the previous
   * owner's last_failure (the fresh row must not inherit a stale error).
   */
  async register(
    user: RequestUser,
    dto: RegisterDeviceTokenDto,
  ): Promise<void> {
    try {
      await this.pg.withTransaction((tx) =>
        tx.query(
          `insert into public.device_tokens
             (token, user_id, platform, app_version, last_seen_at, last_failure)
           values ($1, $2, $3, $4, now(), null)
           on conflict (token) do update set
             user_id      = excluded.user_id,
             platform     = excluded.platform,
             app_version  = excluded.app_version,
             last_seen_at = now(),
             last_failure = null`,
          [dto.token, user.userId, dto.platform, dto.appVersion ?? null],
        ),
      );
    } catch (err) {
      this.logFailure('register', user.userId, dto.token, err);
      throw this.internal('Failed to register the device for push');
    }
  }

  /**
   * Delete the CALLER'S OWN row for this token. Foreign rows (another
   * user's device) are invisible: the delete matches on user_id too, so
   * user B can never unregister user A's device and the explicit-logout
   * repeat (or an offline-logout retry on next start) stays a silent 204.
   */
  async unregister(user: RequestUser, token: string): Promise<void> {
    try {
      await this.pg.withTransaction((tx: PoolClient) =>
        tx.query(
          `delete from public.device_tokens where token = $1 and user_id = $2`,
          [token, user.userId],
        ),
      );
    } catch (err) {
      this.logFailure('unregister', user.userId, token, err);
      throw this.internal('Failed to unregister the device for push');
    }
  }

  /** Context without the secret: a 12-char prefix is enough to correlate. */
  private logFailure(
    op: string,
    userId: string,
    token: string,
    err: unknown,
  ): void {
    this.logger.error(
      `Failed to ${op} device token (code=${readErrorCode(err)})`,
      {
        // Never the error object: a Postgres constraint error carries the row
        // (token included) in err.detail. The error code is all we log.
        userId,
        tokenPrefix: token.slice(0, 12),
      },
    );
  }

  private internal(message: string): InternalServerErrorException {
    return new InternalServerErrorException({
      error_code: ErrorCode.INTERNAL_SERVER_ERROR,
      message,
    });
  }
}

function readErrorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.['code'];
  return typeof code === 'string' && code.length > 0 ? code : 'none';
}
