import { Inject, Injectable } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';

interface RateLimitEntry {
  count: number;
  expiresAt: number;
}

export interface RateLimitIncrementResult {
  count: number;
  /**
   * Seconds left in the CURRENT window (ceil, minimum 1) — what a tripped 429
   * should report as Retry-After, instead of the full window length: a client
   * backing off the remaining time recovers as soon as the window actually
   * resets. For a fresh window this equals the full ttl.
   */
  windowRemainingSeconds: number;
}

/**
 * In-memory (cache-manager backed) rate-limit counter for the autosuggest
 * endpoint. Mirrors `InMemoryOtpSessionStore.increment()` but with its own
 * `places:rate:` key prefix and budget — independent from the OTP rate
 * limit and from the future resolve-endpoint budget (Story 1.2).
 */
@Injectable()
export class PlacesRateLimitStore {
  constructor(@Inject(CACHE_MANAGER) private readonly cache: Cache) {}

  async increment(
    key: string,
    ttlSeconds: number,
  ): Promise<RateLimitIncrementResult> {
    const cacheKey = `places:rate:${key}`;
    const existing = await this.cache.get<RateLimitEntry>(cacheKey);

    if (!existing) {
      const entry: RateLimitEntry = {
        count: 1,
        expiresAt: Date.now() + ttlSeconds * 1000,
      };
      await this.cache.set(cacheKey, entry, ttlSeconds * 1000);
      return { count: 1, windowRemainingSeconds: ttlSeconds };
    }

    // Preserve the original window expiry rather than resetting it on each
    // increment. Note: this get→set is not atomic; a Redis migration should
    // use INCRBY instead (same caveat as InMemoryOtpSessionStore).
    const remainingMs = Math.max(1, existing.expiresAt - Date.now());
    const next = existing.count + 1;
    await this.cache.set(
      cacheKey,
      { count: next, expiresAt: existing.expiresAt },
      remainingMs,
    );
    return {
      count: next,
      windowRemainingSeconds: Math.max(1, Math.ceil(remainingMs / 1000)),
    };
  }
}
