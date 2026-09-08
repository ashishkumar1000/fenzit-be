import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PlacesProvider,
  PlaceSuggestion,
  ResolvedPlace,
} from './places-provider';
import { PlacesRateLimitStore } from './places-rate-limit.store';
import { ErrorCode } from '../common/enums/error-code.enum';
import { RequestUser } from '../common/interfaces/request-user.interface';

// Default autosuggest budget — override per environment via the
// PLACES_AUTOSUGGEST_RATE_LIMIT_* env vars (declared in app.module.ts), so it
// can be retuned without a redeploy. Autosuggest is typed-ahead (fires per
// keystroke), so the budget is far higher than resolve's. Exported so tests
// (e2e rate-limit case) don't hardcode a duplicate magic number.
export const RATE_LIMIT_WINDOW_SECONDS = 60;
export const RATE_LIMIT_MAX = 30;

// Default resolve budget — override per environment via the
// PLACES_RESOLVE_RATE_LIMIT_* env vars. Resolve fires once per selection
// (not per keystroke), so its budget is independent from — and much lower
// than — autosuggest's. Exported so tests (e2e rate-limit case) don't
// hardcode a duplicate magic number.
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
    private readonly configService: ConfigService,
  ) {}

  async autosuggest(
    user: RequestUser,
    query: string,
    sessionToken: string,
  ): Promise<AutosuggestResult> {
    const tenantKey = user.tenantId ?? user.userId;
    const budget = this.rateLimitBudget(
      'PLACES_AUTOSUGGEST_RATE_LIMIT_WINDOW_SECONDS',
      'PLACES_AUTOSUGGEST_RATE_LIMIT_MAX',
      RATE_LIMIT_WINDOW_SECONDS,
      RATE_LIMIT_MAX,
    );

    await this.enforceRateLimit(
      `${tenantKey}:autosuggest`,
      budget.windowSeconds,
      budget.max,
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
    const budget = this.rateLimitBudget(
      'PLACES_RESOLVE_RATE_LIMIT_WINDOW_SECONDS',
      'PLACES_RESOLVE_RATE_LIMIT_MAX',
      RESOLVE_RATE_LIMIT_WINDOW_SECONDS,
      RESOLVE_RATE_LIMIT_MAX,
    );

    await this.enforceRateLimit(
      `${tenantKey}:resolve`,
      budget.windowSeconds,
      budget.max,
      'resolve',
      upstreamMessage,
    );

    let resolved: ResolvedPlace;
    try {
      resolved = await this.placesProvider.resolve(placeId, sessionToken, 'IN');
    } catch (error) {
      this.throwUpstreamError(
        'Places provider failed to resolve place:',
        error,
        upstreamMessage,
      );
    }

    // Runtime guard on the ResolvedPlace contract ("always real numbers,
    // never null/placeholder"): `number` in the type is doc-level only — a
    // provider parsing external JSON (e.g. GooglePlacesProvider) could return
    // NaN/Infinity, which `typeof === 'number'` checks do not catch.
    if (
      !Number.isFinite(resolved.latitude) ||
      !Number.isFinite(resolved.longitude)
    ) {
      this.throwUpstreamError(
        `Places provider returned non-finite coordinates for placeId ${placeId}:`,
        new Error(`latitude=${resolved.latitude} longitude=${resolved.longitude}`),
        upstreamMessage,
      );
    }

    return resolved;
  }

  /**
   * Resolves a rate-limit budget from config/env, falling back to the
   * hardcoded defaults above when the optional env var is unset — so the
   * budgets can be retuned without a redeploy (see app.module.ts for the
   * declared env contract).
   */
  private rateLimitBudget(
    windowKey: string,
    maxKey: string,
    defaultWindowSeconds: number,
    defaultMax: number,
  ): { windowSeconds: number; max: number } {
    return {
      windowSeconds:
        this.configService.get<number>(windowKey) ?? defaultWindowSeconds,
      max: this.configService.get<number>(maxKey) ?? defaultMax,
    };
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
          // Not sent as a body field: the global exception filter lifts this
          // key out of the envelope into a Retry-After response header, so
          // typeahead clients know how long to back off before retrying.
          retryAfterSeconds: windowSeconds,
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
