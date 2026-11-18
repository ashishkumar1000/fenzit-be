import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseClientFactory } from '../../common/factories/supabase-client.factory';
import {
  runWithCorrelation,
  CorrelationContext,
} from '../../common/correlation/correlation.context';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { ReportRegistry } from '../registry/report-registry';
import { ReportRequestRow } from '../report-response.model';
import { ReportRequestStatus } from '../enums/report-status.enum';
import { ReportPipelineService } from './report-pipeline.service';
import { ReportQueueService } from '../report-queue.service';
import {
  claimQueuedReport,
  markReportFailed,
  recoverExpiredReport,
} from './report-claims';
import { insertReportNotification } from './report-notifications';

/**
 * In-process poll worker (FR-4) — the queue is the report_requests table,
 * there is no broker (free tier). Each tick picks up candidates, claims and
 * processes them sequentially (NFR-1: concurrency capped, default 1;
 * head-of-line blocking across tenants is accepted at v1 scale).
 *
 * Lifecycle: starts on app bootstrap, cleared on module destroy. Every
 * deploy kills the worker mid-render — lease recovery makes that routine,
 * not exceptional. An overlapping tick is guarded by a simple isRunning
 * flag so a slow render never stacks intervals.
 */
@Injectable()
export class ReportWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ReportWorker.name);
  private readonly pollIntervalMs: number;
  private readonly leaseMs: number;
  private readonly concurrency: number;
  private readonly maxAttempts: number;
  /** Exclusive worker (test environments): the one legal owner of the
   *  queue — it skips the pause check so the pause can fence every OTHER
   *  worker (the deployed one) without stalling this run's own processing. */
  private readonly exclusive: boolean;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly supabaseClientFactory: SupabaseClientFactory,
    private readonly pipeline: ReportPipelineService,
    private readonly registry: ReportRegistry,
    private readonly configService: ConfigService,
    private readonly queue: ReportQueueService,
  ) {
    this.pollIntervalMs =
      (configService.get<number>('REPORT_POLL_INTERVAL_SECONDS') ?? 5) * 1000;
    this.leaseMs =
      (configService.get<number>('REPORT_LEASE_SECONDS') ?? 300) * 1000;
    this.concurrency =
      configService.get<number>('REPORT_WORKER_CONCURRENCY') ?? 1;
    this.maxAttempts = configService.get<number>('REPORT_MAX_ATTEMPTS') ?? 3;
    // Parsed strictly ('true' only): ConfigService hands back the raw env
    // string, and a truthy 'false' would silently make this worker
    // pause-immune — exactly the misconfiguration the fence can never see.
    this.exclusive =
      configService.get<string>('REPORT_WORKER_EXCLUSIVE') === 'true';
    // Test-only flag, by design: an exclusive worker ignores the pause for
    // EVERY tenant, so one that slips into a deployment voids the pause
    // API's entire contract. Fail the boot instead.
    if (this.exclusive && process.env['NODE_ENV'] === 'production') {
      throw new Error(
        'REPORT_WORKER_EXCLUSIVE is test-only — a deployed worker must respect the report-queue pause',
      );
    }
  }

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), this.pollIntervalMs);
    this.logger.log(
      `Report worker polling every ${this.pollIntervalMs}ms (concurrency ${this.concurrency})`,
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
      const admin = this.supabaseClientFactory.createAdmin();
      // 23-8: the per-tenant pause fences claims for the paused tenants in
      // every worker that respects it — claims stop for those tenants
      // everywhere, in-flight reports finish on their leases, and everyone
      // else's reports keep flowing. An exclusive worker (tests) skips the
      // check: it is the pause's intended exemption, the sole legal claimer
      // while others are fenced.
      const pausedTenants = this.exclusive
        ? new Set<string>()
        : await this.queue.pausedTenantIds();
      // The paused set goes INTO the candidate query, not a post-filter:
      // candidates are the OLDEST rows under limit(concurrency) — filtering
      // afterwards would let one paused tenant's head-of-line rows starve
      // every other tenant for the whole pause.
      const ids = await this.candidateIds(admin, pausedTenants);
      // Sequential processing: concurrency default 1 — one render at a time.
      for (const id of ids.slice(0, this.concurrency)) {
        await this.processOne(admin, id);
      }
    } catch (err) {
      this.logger.error('Report worker tick failed:', err);
    } finally {
      this.running = false;
    }
  }

  /** Queued oldest-first (with attempt_count and tenant for the claim),
   *  then rows stranded past their lease — both excluding the paused
   *  tenants' rows in SQL (an empty pause set skips the filter entirely). */
  private async candidateIds(
    admin: SupabaseClient,
    pausedTenants: Set<string>,
  ): Promise<{ id: string; tenantId: string; attemptCount: number }[]> {
    const nowIso = new Date().toISOString();
    // PostgREST's `not.in` takes a parenthesised CSV; an empty pause set
    // would produce a meaningless `not.in.()`, so the filter is skipped.
    const pausedCsv = `(${[...pausedTenants].join(',')})`;

    const queued = await (pausedTenants.size > 0
      ? admin
          .from('report_requests')
          .select('id, tenant_id, attempt_count')
          .eq('status', ReportRequestStatus.QUEUED)
          .not('tenant_id', 'in', pausedCsv)
      : admin
          .from('report_requests')
          .select('id, tenant_id, attempt_count')
          .eq('status', ReportRequestStatus.QUEUED)
    )
      .order('created_at', { ascending: true })
      .limit(this.concurrency);

    if (queued.error) {
      throw queued.error;
    }

    const stranded = await (pausedTenants.size > 0
      ? admin
          .from('report_requests')
          .select('id, tenant_id, attempt_count')
          .eq('status', ReportRequestStatus.GENERATING)
          .lt('locked_until', nowIso)
          .not('tenant_id', 'in', pausedCsv)
      : admin
          .from('report_requests')
          .select('id, tenant_id, attempt_count')
          .eq('status', ReportRequestStatus.GENERATING)
          .lt('locked_until', nowIso)
    )
      .order('locked_until', { ascending: true })
      .limit(this.concurrency);

    if (stranded.error) {
      throw stranded.error;
    }

    const toCandidates = (
      rows: { id: string; tenant_id: string; attempt_count: number }[],
    ) =>
      rows.map((r) => ({
        id: r.id,
        tenantId: r.tenant_id,
        attemptCount: r.attempt_count,
      }));
    return [
      ...toCandidates(queued.data ?? []),
      ...toCandidates(stranded.data ?? []),
    ];
  }

  private async processOne(
    admin: SupabaseClient,
    candidate: { id: string; tenantId: string; attemptCount: number },
  ): Promise<void> {
    // ALS context does not cross the job-queue boundary — each job mints its
    // own correlation id so worker logs are traceable per job. tenant/user
    // stay null until the claim lands and the row is known (seeded below).
    const context: CorrelationContext = {
      correlationId: randomUUID(),
      sessionId: null,
      userId: null,
      tenantId: null,
    };
    // The catch stays INSIDE the run scope: a job failure logged after the
    // scope unwound (in tick's catch) would lose the correlation id.
    return runWithCorrelation(context, async () => {
      try {
        await this.claimAndProcess(admin, candidate, context);
      } catch (err) {
        this.logger.error('Report job failed:', err);
      }
    });
  }

  private async claimAndProcess(
    admin: SupabaseClient,
    candidate: { id: string; tenantId: string; attemptCount: number },
    context: CorrelationContext,
  ): Promise<void> {
    const lockedUntil = new Date(Date.now() + this.leaseMs).toISOString();

    // Try a fresh queued claim first, then lease recovery. Exactly one
    // guarded UPDATE wins; the loser updates zero rows and we move on.
    let row = await claimQueuedReport(
      admin,
      candidate.id,
      lockedUntil,
      candidate.attemptCount,
    );
    let recovered = false;
    if (!row) {
      row = await recoverExpiredReport(
        admin,
        candidate.id,
        lockedUntil,
        candidate.attemptCount,
      );
      recovered = row !== null;
    }
    if (!row) {
      return; // lost the race or the lease is still held — nothing to do
    }

    // Seed the tenant/user ids from the claimed row — the store object is
    // ours to mutate, so every later log line in this job carries them.
    context.tenantId = row.tenant_id;
    context.userId = row.requested_by;

    if (recovered && row.attempt_count > this.maxAttempts) {
      // The recovery claim spent an attempt past the cap — fail the row
      // instead of re-running it (REPORT_MAX_ATTEMPTS default 3).
      this.logger.warn('Report exceeded max attempts:', {
        tenantId: row.tenant_id,
        reportRequestId: row.id,
        currentStatus: row.status,
        attempts: row.attempt_count,
      });
      await markReportFailed(admin, row.id, ErrorCode.REPORT_GENERATION_FAILED);
    } else {
      this.logger.log('Processing report request', {
        reportRequestId: row.id,
        tenantId: row.tenant_id,
        currentStatus: row.status,
        reportType: row.report_type,
        attempt: row.attempt_count,
      });
      await this.pipeline.run(row);
    }

    // Re-read the terminal outcome for the notification (the pipeline or
    // the max-attempts path stamped it) and notify requested_by.
    const finalRow = await this.readRow(admin, row.id);
    if (finalRow) {
      await this.notifyTerminal(admin, finalRow);
    }
  }

  private async readRow(
    admin: SupabaseClient,
    id: string,
  ): Promise<ReportRequestRow | null> {
    const { data, error } = await admin
      .from('report_requests')
      .select('*')
      .eq('id', id)
      .maybeSingle<ReportRequestRow>();
    if (error) {
      throw error;
    }
    return data ?? null;
  }

  private async notifyTerminal(
    admin: SupabaseClient,
    row: ReportRequestRow,
  ): Promise<void> {
    const isTerminal =
      row.status === ReportRequestStatus.READY ||
      row.status === ReportRequestStatus.FAILED;
    if (!isTerminal) {
      return;
    }
    const label = this.registry.get(row.report_type)?.label ?? row.report_type;
    await insertReportNotification(admin, row, label);
  }
}
