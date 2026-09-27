import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient } from 'pg';

/**
 * Direct Postgres access for the attendance lifecycle writes (15-7).
 *
 * Why a raw pool instead of the supabase-js admin client: the AD-8
 * algorithm (delete future → clip covering → insert) and the deferrable
 * coverage constraint trigger only hold inside ONE transaction, and
 * PostgREST/supabase-js cannot run multi-statement transactions. A direct
 * connection is Supabase's documented pattern for long-lived backends
 * (docs/guides/database/connecting-to-postgres) — reads keep flowing
 * through the admin client; only the transactional enrolment writes use
 * this pool.
 *
 * DATABASE_URL is the direct connection (db.<ref>.supabase.co:5432) or the
 * session-mode pooler (aws-<n>-<region>.pooler.supabase.com:5432) when the
 * host network is IPv4-only — both pin one backend per client, which the
 * xact-scoped advisory locks require. The transaction-mode pooler (6543)
 * must NOT be used here.
 */
@Injectable()
export class PgPoolFactory implements OnModuleDestroy {
  private readonly logger = new Logger(PgPoolFactory.name);
  private readonly pool: Pool;

  constructor(configService: ConfigService) {
    // Fail fast at boot — a missing URL must never surface as a runtime 500
    // from a dead pool.
    this.pool = new Pool({
      connectionString: configService.getOrThrow<string>('DATABASE_URL'),
      max: 5,
      ssl: { rejectUnauthorized: false },
      application_name: 'fenzit-be-attendance',
    });
  }

  /**
   * Runs `work` inside one transaction: BEGIN → SET LOCAL search_path →
   * work → COMMIT, with ROLLBACK + rethrow on any failure. The client is
   * always released. Parameterised queries only — callers never interpolate.
   */
  async withTransaction<T>(
    work: (tx: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Cap a stalled statement so one hung query cannot pin the small
      // pool until it is exhausted (review finding).
      await client.query('SET LOCAL statement_timeout = 10000');
      await client.query('SET LOCAL search_path = public');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch((rollbackErr: unknown) => {
        this.logger.error('ROLLBACK failed after error:', rollbackErr);
      });
      throw err;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
