import { createHash } from 'crypto';
import {
  Injectable,
  InternalServerErrorException,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { ErrorCode } from '../common/enums/error-code.enum';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';

/**
 * The response body of GET /config/app: a flat key → JSON-value map (clients
 * ignore keys they don't know, so rows can be added without shipping apps)
 * plus the newest row's updated_at as a cheap change detector.
 */
export interface AppConfigPayload {
  config: Record<string, unknown>;
  configVersion: string;
}

export interface AppConfigRead {
  payload: AppConfigPayload;
  /** Strong ETag (quoted), derived from the serialized payload. */
  etag: string;
}

interface CacheEntry extends AppConfigRead {
  fetchedAtMs: number;
}

/**
 * Belt: staleness bound when the realtime socket (suspenders) is down — a
 * dropped subscription must never mean unbounded staleness.
 */
const CACHE_TTL_MS = 60_000;

/**
 * In-memory read model over the global `app_config` table (SPEC-server-
 * driven-config). One DB read per instance per change, not per request:
 * the entry is invalidated by a Supabase Realtime change event and by the
 * TTL, whichever fires first. Render runs a single instance, so an
 * in-process map is the whole cache — no shared store needed.
 */
@Injectable()
export class AppConfigService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AppConfigService.name);
  private cache: CacheEntry | null = null;
  private realtimeClient: SupabaseClient | null = null;
  private channel: RealtimeChannel | null = null;

  constructor(private readonly supabaseClientFactory: SupabaseClientFactory) {}

  onModuleInit(): void {
    // Fire-and-forget on purpose: the socket must never slow or fail boot —
    // if it never connects, the TTL still bounds staleness.
    try {
      const admin = this.supabaseClientFactory.createAdmin();
      this.realtimeClient = admin;
      this.channel = admin
        .channel('app_config_changes')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'app_config' },
          () => {
            // Invalidate, don't patch: the next read refetches the whole
            // table, so there is no second source of truth to drift.
            this.cache = null;
          },
        )
        .subscribe();
    } catch (err) {
      this.logger.warn(
        'app_config realtime subscription failed to start; relying on the cache TTL',
        err,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.realtimeClient || !this.channel) return;
    // Best-effort: shutdown must not hang on a dead socket.
    try {
      await this.realtimeClient.removeChannel(this.channel);
    } catch {
      /* already gone */
    }
  }

  async getAppConfig(): Promise<AppConfigRead> {
    if (this.cache && Date.now() - this.cache.fetchedAtMs < CACHE_TTL_MS) {
      const { payload, etag } = this.cache;
      return { payload, etag };
    }

    const admin = this.supabaseClientFactory.createAdmin();
    const { data, error } = await admin
      .from('app_config')
      .select('key, value, updated_at');

    if (error || !data) {
      this.logger.error('Failed to read app_config:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to read app config',
      });
    }

    const config: Record<string, unknown> = {};
    let latestMs = 0;
    for (const row of data) {
      config[row.key] = row.value;
      const ts = Date.parse(String(row.updated_at));
      if (Number.isFinite(ts) && ts > latestMs) latestMs = ts;
    }
    const payload: AppConfigPayload = {
      config,
      configVersion: new Date(latestMs).toISOString(),
    };
    const etag = `"${createHash('sha1')
      .update(JSON.stringify(payload))
      .digest('hex')}"`;
    this.cache = { payload, etag, fetchedAtMs: Date.now() };
    return { payload, etag };
  }
}
