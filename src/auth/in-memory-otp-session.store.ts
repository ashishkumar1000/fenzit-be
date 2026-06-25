import { Inject, Injectable } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { OtpSession, OtpSessionStore } from './otp-session-store';

@Injectable()
export class InMemoryOtpSessionStore extends OtpSessionStore {
  constructor(@Inject(CACHE_MANAGER) private readonly cache: Cache) {
    super();
  }

  async set(
    sessionId: string,
    value: OtpSession,
    ttlSeconds: number,
  ): Promise<void> {
    await this.cache.set(`otp:session:${sessionId}`, value, ttlSeconds * 1000);
  }

  async get(sessionId: string): Promise<OtpSession | null> {
    const session = await this.cache.get<OtpSession>(
      `otp:session:${sessionId}`,
    );
    return session ?? null;
  }

  async delete(sessionId: string): Promise<void> {
    await this.cache.del(`otp:session:${sessionId}`);
  }

  async increment(key: string, ttlSeconds: number): Promise<number> {
    const cacheKey = `otp:rate:${key}`;
    type Entry = { count: number; expiresAt: number };
    const existing = await this.cache.get<Entry>(cacheKey);

    if (!existing) {
      const entry: Entry = {
        count: 1,
        expiresAt: Date.now() + ttlSeconds * 1000,
      };
      await this.cache.set(cacheKey, entry, ttlSeconds * 1000);
      return 1;
    }

    // Preserve the original window expiry rather than resetting it on each increment.
    // Note: this get→set is not atomic; Phase 2 Redis migration should use INCRBY instead.
    const remainingMs = Math.max(1, existing.expiresAt - Date.now());
    const next = existing.count + 1;
    await this.cache.set(
      cacheKey,
      { count: next, expiresAt: existing.expiresAt },
      remainingMs,
    );
    return next;
  }
}
