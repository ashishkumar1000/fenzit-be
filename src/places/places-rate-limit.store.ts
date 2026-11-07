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
/**
 * Shared counter for every places rate limit (autosuggest, reverse geocode,
 * forward geocode).
 *
 * Concurrency: `increment()` is a read-modify-write (get, then set). Two calls
 * for the same key must never interleave, or they both read the same count and
 * the limit is not enforced under a burst. `runExclusive()` queues the calls
 * for each cache key one after another, inside this process.
 *
 * Scope: this is per process only. Each app instance keeps its own counter, so
 * with N instances a client can get up to N x limit per window. A hard global
 * limit needs a shared store (for example Redis INCR with EXPIRE), which
 * would replace the body of `increment()` and not change its signature.
 */
@Injectable()
export class PlacesRateLimitStore {
  /**
   * Tail of the queue for each cache key that has calls in flight. A tail
   * never rejects, so one failed call cannot block the calls queued after it.
   * An entry is removed as soon as its queue drains, so the map only holds
   * keys with work in progress.
   */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(@Inject(CACHE_MANAGER) private readonly cache: Cache) {}

  async increment(
    key: string,
    ttlSeconds: number,
  ): Promise<RateLimitIncrementResult> {
    const cacheKey = `places:rate:${key}`;
    return this.runExclusive(cacheKey, () =>
      this.incrementUnlocked(cacheKey, ttlSeconds),
    );
  }

  private async incrementUnlocked(
    cacheKey: string,
    ttlSeconds: number,
  ): Promise<RateLimitIncrementResult> {
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
    // increment. The get→set is safe only because runExclusive() serialises
    // calls per key in this process. A Redis migration should use INCRBY.
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

  /**
   * Runs `task` after every earlier task queued for the same key has settled.
   * The caller gets the task's own result or error. The queue continues either
   * way.
   */
  private runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const run = previous.then(task);
    const tail: Promise<void> = run.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, tail);
    void tail.then(() => {
      // Drop the entry only if no newer call has queued behind this one.
      if (this.chains.get(key) === tail) {
        this.chains.delete(key);
      }
    });
    return run;
  }
}
