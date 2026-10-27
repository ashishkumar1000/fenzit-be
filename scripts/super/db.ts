import { Pool } from 'pg';

/**
 * The one database interface the super CLI talks to (node-postgres; a Bun
 * SQL adapter was tried in 2026-10 benchmarks and removed — latency-bound,
 * it bought nothing).
 *
 * Every query must:
 *  - parameterise (never interpolate user input);
 *  - give rowCount for DELETE/UPDATE (rows affected, not rows returned);
 *  - run `transaction` work on ONE connection so SET LOCAL and the
 *    audit-trigger DDL apply to the same session;
 *  - roll back and rethrow on any failure inside `transaction`.
 * Transactions default to a 30s statement timeout; the purge lifts it
 * inside its own transaction (see runDeletes).
 */

export interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

export interface Db {
  query(text: string, params?: unknown[]): Promise<QueryResult>;
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  /** Which engine backs this handle — 'pg' (node-postgres) or 'bun' (Bun SQL). */
  readonly driver: 'pg' | 'bun';
}

export function makePgDb(url: string, max = 1): Db {
  const pool = new Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    max,
    // Every query gets a ceiling; the purge transaction lifts it for itself
    // via SET LOCAL statement_timeout = '0' (see runDeletes).
    statement_timeout: 60_000,
    application_name: 'fenzit-super-cli',
  });
  return {
    driver: 'pg',
    async query(text, params = []) {
      const res = await pool.query(text, params);
      return { rows: res.rows as Record<string, unknown>[], rowCount: res.rowCount ?? 0 };
    },
    async transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      const tx: Db = {
        driver: 'pg',
        query: async (text, params = []) => {
          const res = await client.query(text, params);
          return { rows: res.rows as Record<string, unknown>[], rowCount: res.rowCount ?? 0 };
        },
        transaction: (innerWork) => innerWork(tx),
        close: async () => undefined,
      };
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL statement_timeout = '30s'");
        await client.query('SET LOCAL search_path = public');
        const out = await work(tx);
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
