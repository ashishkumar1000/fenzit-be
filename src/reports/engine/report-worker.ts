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
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly supabaseClientFactory: SupabaseClientFactory,
    private readonly pipeline: ReportPipelineService,
    private readonly registry: ReportRegistry,
    private readonly configService: ConfigService,
  ) {
    this.pollIntervalMs =
      (configService.get<number>('REPORT_POLL_INTERVAL_SECONDS') ?? 5) * 1000;
    this.leaseMs =
      (configService.get<number>('REPORT_LEASE_SECONDS') ?? 300) * 1000;
    this.concurrency =
      configService.get<number>('REPORT_WORKER_CONCURRENCY') ?? 1;
    this.maxAttempts = configService.get<number>('REPORT_MAX_ATTEMPTS') ?? 3;
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
      const ids = await this.candidateIds(admin);
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

  /** Queued oldest-first (with attempt_count for the claim), then rows
   *  stranded past their lease. */
  private async candidateIds(
    admin: SupabaseClient,
  ): Promise<{ id: string; attemptCount: number }[]> {
    const nowIso = new Date().toISOString();

    const queued = await admin
      .from('report_requests')
      .select('id, attempt_count')
      .eq('status', ReportRequestStatus.QUEUED)
      .order('created_at', { ascending: true })
      .limit(this.concurrency);

    if (queued.error) {
      throw queued.error;
    }

    const stranded = await admin
      .from('report_requests')
      .select('id, attempt_count')
      .eq('status', ReportRequestStatus.GENERATING)
      .lt('locked_until', nowIso)
      .order('locked_until', { ascending: true })
      .limit(this.concurrency);

    if (stranded.error) {
      throw stranded.error;
    }

    const toCandidates = (rows: { id: string; attempt_count: number }[]) =>
      rows.map((r) => ({ id: r.id, attemptCount: r.attempt_count }));
    return [
      ...toCandidates(queued.data ?? []),
      ...toCandidates(stranded.data ?? []),
    ];
  }

  private async processOne(
    admin: SupabaseClient,
    candidate: { id: string; attemptCount: number },
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
    candidate: { id: string; attemptCount: number },
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
