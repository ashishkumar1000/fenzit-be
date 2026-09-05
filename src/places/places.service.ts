import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  PlacesProvider,
  PlaceSuggestion,
  ResolvedPlace,
} from './places-provider';
import { PlacesRateLimitStore } from './places-rate-limit.store';
import { ErrorCode } from '../common/enums/error-code.enum';
import { RequestUser } from '../common/interfaces/request-user.interface';

// Autosuggest is typed-ahead (fires per keystroke), so the budget is far
// higher than the OTP send budget — independent window/limit from any
// future resolve-endpoint budget (Story 1.2). Exported so tests (e2e rate
// limit case) don't hardcode a duplicate magic number.
export const RATE_LIMIT_WINDOW_SECONDS = 60;
export const RATE_LIMIT_MAX = 30;

// Resolve fires once per selection (not per keystroke), so its budget is
// independent from — and much lower than — autosuggest's. Exported so tests
// (e2e rate limit case) don't hardcode a duplicate magic number.
export const RESOLVE_RATE_LIMIT_WINDOW_SECONDS = 60;
export const RESOLVE_RATE_LIMIT_MAX = 10;

export interface AutosuggestResult {
  suggestions: PlaceSuggestion[];
}

@Injectable()
export class PlacesService {
  private readonly logger = new Logger(PlacesService.name);

  constructor(
    private readonly placesProvider: PlacesProvider,
    private readonly rateLimitStore: PlacesRateLimitStore,
  ) {}

  async autosuggest(
    user: RequestUser,
    query: string,
    sessionToken: string,
  ): Promise<AutosuggestResult> {
    const tenantKey = user.tenantId ?? user.userId;

    await this.enforceRateLimit(
      `${tenantKey}:autosuggest`,
      RATE_LIMIT_WINDOW_SECONDS,
      RATE_LIMIT_MAX,
      'autosuggest',
      'Unable to fetch address suggestions right now',
    );

    try {
      const suggestions = await this.placesProvider.autosuggest(
        query,
        sessionToken,
        'IN',
      );
      return { suggestions };
    } catch (error) {
      this.throwUpstreamError(
        'Places provider failed to return suggestions:',
        error,
        'Unable to fetch address suggestions right now',
      );
    }
  }

  async resolve(
    user: RequestUser,
    placeId: string,
    sessionToken: string,
  ): Promise<ResolvedPlace> {
    const tenantKey = user.tenantId ?? user.userId;
    const upstreamMessage = 'Unable to resolve the selected address right now';

    await this.enforceRateLimit(
      `${tenantKey}:resolve`,
      RESOLVE_RATE_LIMIT_WINDOW_SECONDS,
      RESOLVE_RATE_LIMIT_MAX,
      'resolve',
      upstreamMessage,
    );

    try {
      return await this.placesProvider.resolve(placeId, sessionToken, 'IN');
    } catch (error) {
      this.throwUpstreamError(
        'Places provider failed to resolve place:',
        error,
        upstreamMessage,
      );
    }
  }

  /**
   * Increments the rate-limit counter for `key` and throws the documented 429
   * envelope if the request would exceed `max` within `windowSeconds`. A
   * cache-backend hiccup on increment is mapped to the same documented
   * upstream-error 502 the provider-failure branches use, rather than
   * surfacing as an undocumented generic 500. `label` is used both in the
   * rate-limit key's caller-facing message (e.g. "autosuggest"/"resolve") and
   * has no effect on the store key itself (that's passed in via `key`).
   */
  private async enforceRateLimit(
    key: string,
    windowSeconds: number,
    max: number,
    label: string,
    upstreamMessage: string,
  ): Promise<void> {
    let requestCount: number;
    try {
      requestCount = await this.rateLimitStore.increment(key, windowSeconds);
    } catch (error) {
      this.throwUpstreamError(
        'Places rate-limit store failed to increment:',
        error,
        upstreamMessage,
      );
    }

    if (requestCount > max) {
      throw new HttpException(
        {
          error_code: ErrorCode.RATE_LIMITED,
          message: `Too many ${label} requests. Maximum ${max} requests allowed per ${windowSeconds} seconds.`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * Logs a proper stack trace and throws the documented 502 envelope.
   *
   * Node's `fetch` (undici) wraps the real network failure — DNS, TLS,
   * connection-refused, timeout — in `error.cause`, which `error.stack`
   * alone never includes. Without logging it separately, every network-level
   * failure looks identical in the logs ("TypeError: fetch failed"),
   * hiding the one detail needed to diagnose it.
   */
  private throwUpstreamError(
    logMessage: string,
    error: unknown,
    userMessage: string,
  ): never {
    this.logger.error(
      logMessage,
      error instanceof Error ? error.stack : String(error),
    );
    const cause = error instanceof Error ? error.cause : undefined;
    if (cause) {
      this.logger.error(
        'Caused by:',
        cause instanceof Error ? cause.stack : String(cause),
      );
    }
    throw new HttpException(
      {
        error_code: ErrorCode.PLACES_UPSTREAM_ERROR,
        message: userMessage,
      },
      HttpStatus.BAD_GATEWAY,
    );
  }
}
