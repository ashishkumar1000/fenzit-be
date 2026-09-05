import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { PlacesProvider, PlaceSuggestion } from './places-provider';
import { PlacesRateLimitStore } from './places-rate-limit.store';
import { ErrorCode } from '../common/enums/error-code.enum';
import { RequestUser } from '../common/interfaces/request-user.interface';

// Autosuggest is typed-ahead (fires per keystroke), so the budget is far
// higher than the OTP send budget — independent window/limit from any
// future resolve-endpoint budget (Story 1.2). Exported so tests (e2e rate
// limit case) don't hardcode a duplicate magic number.
export const RATE_LIMIT_WINDOW_SECONDS = 60;
export const RATE_LIMIT_MAX = 30;

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

    let requestCount: number;
    try {
      requestCount = await this.rateLimitStore.increment(
        `${tenantKey}:autosuggest`,
        RATE_LIMIT_WINDOW_SECONDS,
      );
    } catch (error) {
      // A cache-backend hiccup here must not surface as an undocumented
      // generic 500 — map it to the same documented upstream-error code the
      // provider-failure branch below uses.
      this.throwUpstreamError(
        'Places rate-limit store failed to increment:',
        error,
      );
    }

    if (requestCount > RATE_LIMIT_MAX) {
      throw new HttpException(
        {
          error_code: ErrorCode.RATE_LIMITED,
          message: `Too many autosuggest requests. Maximum ${RATE_LIMIT_MAX} requests allowed per ${RATE_LIMIT_WINDOW_SECONDS} seconds.`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

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
      );
    }
  }

  /** Logs a proper stack trace and throws the documented 502 envelope. */
  private throwUpstreamError(logMessage: string, error: unknown): never {
    this.logger.error(
      logMessage,
      error instanceof Error ? error.stack : String(error),
    );
    throw new HttpException(
      {
        error_code: ErrorCode.PLACES_UPSTREAM_ERROR,
        message: 'Unable to fetch address suggestions right now',
      },
      HttpStatus.BAD_GATEWAY,
    );
  }
}
