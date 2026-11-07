import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
// A VALUE import on purpose: the constructor injects ConfigService, and a
// type-only import would erase the design:paramtypes metadata Nest needs
// to resolve it (boot failure: "dependencies: [class Object]").
import { ConfigService } from '@nestjs/config';
import type { PoolClient } from 'pg';
import { PgPoolFactory } from '../common/pg/pg-pool.factory';
import { NoopPushSender } from './noop-push-sender';
import { pushCopyForEvent } from './push-copy';
import { PushMessage, PushSender, PushSendOutcome } from './push-sender.port';

/**
 * The outbox sweep (CAP-2). Every notifications row is written by an RPC,
 * pg_cron or a TS insert, so the only writer-agnostic trigger is the
 * pushed_at column the table reserved for this worker: each tick claims
 * unsent recent rows atomically (FOR UPDATE SKIP LOCKED — multi-instance
 * safe, no broker), looks up the recipient's tokens ONCE per batch, and
 * sends one hybrid message per token.
 *
 * Additive and decoupled by design (SPEC constraint): the row was claimed
 * BEFORE any send, so a failure can never fail an insert or an API
 * response — it only writes last_failure and logs. Claim-then-send is
 * at-most-once; the in-app bell (Realtime + the inbox API) remains the
 * source of truth a push merely augments.
 *
 * Tenant guard (user requirement 2026-11-07, frozen): a row is pushed only
 * to tokens whose user IS the row's user_id and who is a non-disabled,
 * active member of the row's tenant — the join below makes a push never
 * reach anyone the bell would not show the row to right now (removed,
 * disabled, or active-in-another-tenant recipients are skipped silently).
 *
 * Lifecycle: interval from OnModuleInit, cleared on module destroy; a
 * `running` flag keeps a slow tick (send retries included) from stacking
 * (the ReportWorker precedent). Only armed when the provider is fcm —
 * noop boots and never sweeps (acceptance).
 */

interface ClaimedNotificationRow {
  id: string;
  tenant_id: string;
  user_id: string;
  job_id: string | null;
  event_type: string;
  payload: Record<string, unknown>;
  entity_type: string | null;
  entity_id: string | null;
}

@Injectable()
export class PushSweepService implements OnModuleInit, OnModuleDestroy {
  /** FCM's sendEach hard cap — chunks never exceed it. */
  private static readonly SEND_BATCH_LIMIT = 500;
  /** Notification rows claimed per tick (bounded work, bounded latency). */
  private static readonly CLAIM_BATCH_SIZE = 100;
  /** Frozen matrix: 429/503 retried at most twice, then last_failure. */
  private static readonly MAX_SEND_RETRIES = 2;

  private static readonly CLAIM_SQL = `
    update public.notifications as n
    set pushed_at = now()
    where n.id in (
      select c.id
      from public.notifications as c
      where c.pushed_at is null
        and c.created_at >= now() - make_interval(mins => $1::int)
      order by c.created_at asc
      limit $2
      for update skip locked
    )
    returning n.id, n.tenant_id, n.user_id, n.job_id, n.event_type,
              n.payload, n.entity_type, n.entity_id`;

  /**
   * ONE token lookup per batch: user must not be disabled and must hold an
   * ACTIVE membership in the CLAIMED ROW's tenant (the unnest pairs carry
   * each row's own tenant). device_tokens joins on user_id only — the
   * tenant condition comes from the membership side. DISTINCT is
   * load-bearing: a batch often holds several rows for the SAME recipient
   * (three job steps → three pairs of one owner), and without it the join
   * would return each of that owner's tokens once PER ROW, fanning every
   * row out once per duplicate (3 rows × 3 tokens = 9 pushes for 3).
   */
  private static readonly TOKEN_LOOKUP_SQL = `
    select distinct p.user_id, p.tenant_id, t.token
    from unnest($1::uuid[], $2::uuid[]) as p(user_id, tenant_id)
    join public.users u
      on u.id = p.user_id and u.disabled = false
    join public.memberships m
      on m.user_id = p.user_id and m.tenant_id = p.tenant_id
     and m.status = 'active'
    join public.device_tokens t
      on t.user_id = p.user_id`;

  private readonly logger = new Logger(PushSweepService.name);
  private readonly sweepIntervalMs: number;
  private readonly maxAgeMinutes: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly pg: PgPoolFactory,
    private readonly sender: PushSender,
    configService: ConfigService,
  ) {
    this.sweepIntervalMs =
      (configService.get<number>('PUSH_SWEEP_INTERVAL_SECONDS') ?? 5) * 1000;
    this.maxAgeMinutes =
      configService.get<number>('PUSH_MAX_AGE_MINUTES') ?? 15;
  }

  onModuleInit(): void {
    // The noop provider never sweeps (acceptance: "with noop it boots and
    // never sweeps") — the port stays honest, the interval stays unarmed.
    if (this.sender instanceof NoopPushSender) {
      this.logger.log('Push delivery is noop — sweep not started');
      return;
    }
    this.timer = setInterval(() => void this.tick(), this.sweepIntervalMs);
    this.logger.log(
      `Push sweep every ${this.sweepIntervalMs}ms (max age ${this.maxAgeMinutes}min)`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const { rows, tokensByPair } = await this.claimBatch();
      if (rows.length === 0) {
        return;
      }
      const messages: PushMessage[] = [];
      let skipped = 0;
      for (const row of rows) {
        const tokens =
          tokensByPair.get(pairKey(row.user_id, row.tenant_id)) ?? [];
        if (tokens.length === 0) {
          // Removed/disabled/no-active-membership recipient, or simply no
          // registered device — claimed and dropped either way (the row is
          // not re-sent next tick; the bell still owns the information).
          skipped += 1;
          continue;
        }
        const copy = pushCopyForEvent(row.event_type, row.payload ?? {});
        const targetId = row.job_id ?? row.entity_id;
        const data: Record<string, string> = { type: row.event_type };
        if (targetId) {
          data['id'] = targetId;
        }
        for (const token of tokens) {
          messages.push({
            token,
            title: copy.title,
            body: copy.body,
            data,
            channel: copy.channel,
            visibility: copy.visibility,
          });
        }
      }
      await this.sendAll(messages);
      this.logger.log(
        `Push sweep: claimed ${rows.length} row(s), sent ${messages.length} message(s), skipped ${skipped}`,
      );
    } catch (err) {
      // The sweep is additive: a failed tick only logs. Claimed rows stay
      // claimed (at-most-once), unclaimed rows wait for the next tick.
      this.logger.error('Push sweep tick failed:', err);
    } finally {
      this.running = false;
    }
  }

  /** Atomic claim + the batch's single token lookup, one transaction. */
  private async claimBatch(): Promise<{
    rows: ClaimedNotificationRow[];
    tokensByPair: Map<string, string[]>;
  }> {
    return this.pg.withTransaction(async (tx: PoolClient) => {
      const claimed = await tx.query(PushSweepService.CLAIM_SQL, [
        this.maxAgeMinutes,
        PushSweepService.CLAIM_BATCH_SIZE,
      ]);
      const rows = claimed.rows as ClaimedNotificationRow[];
      const tokensByPair = new Map<string, string[]>();
      if (rows.length === 0) {
        return { rows, tokensByPair };
      }
      const lookedUp = await tx.query(PushSweepService.TOKEN_LOOKUP_SQL, [
        rows.map((row) => row.user_id),
        rows.map((row) => row.tenant_id),
      ]);
      // Set-accumulate per pair: the lookup is DISTINCT, but keeping the
      // dedupe local means a duplicate row can never reach the send loop
      // again (one message per recipient token per notification row — a
      // second copy of a token in a pair's list would double-send it).
      const tokensByPairSets = new Map<string, Set<string>>();
      for (const row of lookedUp.rows as {
        user_id: string;
        tenant_id: string;
        token: string;
      }[]) {
        const key = pairKey(row.user_id, row.tenant_id);
        const tokens = tokensByPairSets.get(key) ?? new Set<string>();
        tokens.add(row.token);
        tokensByPairSets.set(key, tokens);
      }
      for (const [key, tokens] of tokensByPairSets) {
        tokensByPair.set(key, [...tokens]);
      }
      return { rows, tokensByPair };
    });
  }

  /**
   * Send in ≤500 chunks; dead tokens deleted, permanent failures stamped,
   * 429/503 retried at most twice (exponential backoff + jitter — the SDK
   * does not surface FCM's Retry-After per message, so backoff stands in).
   */
  private async sendAll(messages: PushMessage[]): Promise<void> {
    let queue: { message: PushMessage; lastCode: string }[] = messages.map(
      (message) => ({ message, lastCode: 'not-sent' }),
    );
    for (
      let attempt = 0;
      queue.length > 0 && attempt <= PushSweepService.MAX_SEND_RETRIES;
      attempt++
    ) {
      if (attempt > 0) {
        await wait(this.retryDelayMs(attempt));
      }
      const deadTokens: string[] = [];
      const failures: { token: string; code: string }[] = [];
      const retrying: { message: PushMessage; lastCode: string }[] = [];
      for (const chunk of chunks(
        queue.map((entry) => entry.message),
        PushSweepService.SEND_BATCH_LIMIT,
      )) {
        for (const outcome of await this.sendChunk(chunk)) {
          if (!outcome.error) {
            continue;
          }
          const { kind, code } = outcome.error;
          if (kind === 'unregistered' || kind === 'invalid') {
            // Rotation + not-registered: the old token is dead on its next
            // send failure (frozen matrix) — delete so it never re-sends.
            deadTokens.push(outcome.message.token);
          } else if (kind === 'retryable') {
            retrying.push({ message: outcome.message, lastCode: code });
          } else {
            failures.push({ token: outcome.message.token, code });
          }
        }
      }
      await this.deleteTokens(deadTokens);
      await this.recordFailures(failures);
      queue = retrying;
    }
    if (queue.length > 0) {
      // Retries exhausted: stamp the last failure and move on — the row is
      // already claimed, so this push is dropped (the bell still has it).
      await this.recordFailures(
        queue.map((entry) => ({
          token: entry.message.token,
          code: entry.lastCode,
        })),
      );
      this.logger.warn(
        `Push retries exhausted for ${queue.length} message(s); stamped last_failure`,
      );
    }
  }

  /** One chunk with transport-level failures flattened into outcomes. */
  private async sendChunk(chunk: PushMessage[]): Promise<PushSendOutcome[]> {
    try {
      return await this.sender.sendEach(chunk);
    } catch (err) {
      // Auth/network blowups fail the WHOLE chunk indeterminately — treat
      // as retryable and let the attempt loop decide (never throws upward:
      // a push failure must not break the tick).
      this.logger.error('Push send failed at transport level:', err);
      return chunk.map((message) => ({
        message,
        error: {
          kind: 'retryable' as const,
          code: 'messaging/transport-error',
          detail: err instanceof Error ? err.message : String(err),
        },
      }));
    }
  }

  private retryDelayMs(attempt: number): number {
    // 1s after the first failure, 2s after the second, ±500ms jitter.
    const base = 1000 * 2 ** (attempt - 1);
    return base + Math.floor(Math.random() * 500);
  }

  private async deleteTokens(tokens: string[]): Promise<void> {
    if (tokens.length === 0) {
      return;
    }
    await this.pg.withTransaction((tx) =>
      tx.query(
        `delete from public.device_tokens where token = any($1::text[])`,
        [tokens],
      ),
    );
  }

  private async recordFailures(
    failures: { token: string; code: string }[],
  ): Promise<void> {
    if (failures.length === 0) {
      return;
    }
    await this.pg.withTransaction((tx) =>
      tx.query(
        `update public.device_tokens t
         set last_failure = c.code
         from unnest($1::text[], $2::text[]) as c(token, code)
         where t.token = c.token`,
        [failures.map((f) => f.token), failures.map((f) => f.code)],
      ),
    );
  }
}

const pairKey = (userId: string, tenantId: string): string =>
  `${userId}:${tenantId}`;

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
