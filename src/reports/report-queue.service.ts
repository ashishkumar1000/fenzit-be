import { BadRequestException, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { ErrorCode } from '../common/enums/error-code.enum';
import type { RequestUser } from '../common/interfaces/request-user.interface';

/**
 * 23-8: the report-queue pause, PER TENANT (owner request — each company's
 * admin controls their own queue from the admin panel). One row per tenant
 * in report_queue_pauses; every worker (local dev, test, deployed) reads the
 * paused tenants before claiming, so a pause set through this API fences
 * claims for that tenant in every environment at once. The row also powers
 * the admin panel's "is our queue paused, until when, who paused it" view.
 *
 *   paused=true  + paused_until=null            → paused indefinitely
 *   paused=true  + paused_until in the future    → paused until that moment
 *   paused=true  + paused_until in the past      → expired, queue runs again
 *   paused=false                                 → running
 *
 * The in-flight cap, claims and leases are untouched: a pause stops NEW
 * claims for that tenant only, and anything already generating finishes on
 * its lease. Other tenants' reports keep flowing.
 */

/** The minute cap for a timed pause — a maintenance window, not a decade. */
export const MAX_PAUSE_MINUTES = 1440;

export interface ReportQueueState {
  paused: boolean;
  /** ISO instant the pause auto-ends; null = indefinite (or not paused). */
  pausedUntil: string | null;
  pausedBy: string | null;
  pausedAt: string | null;
}

interface PauseRow {
  tenant_id: string;
  paused: boolean;
  paused_until: string | null;
  paused_by: string | null;
  paused_at: string | null;
}

@Injectable()
export class ReportQueueService {
  private readonly logger = new Logger(ReportQueueService.name);

  constructor(private readonly supabaseClientFactory: SupabaseClientFactory) {}

  /** The caller's tenant's pause state, exactly as the panel should show it. */
  async getState(user: RequestUser): Promise<ReportQueueState> {
    const row = await this.readRow(requireTenant(user));
    if (!row) {
      return { paused: false, pausedUntil: null, pausedBy: null, pausedAt: null };
    }
    return normalise(row);
  }

  /** The worker's question, answered in one read: WHICH tenants are paused
   *  right now (claims are per row, so the worker filters candidates by this
   *  set). A read failure is fail-open (logged, empty set) — a broken read
   *  must never wedge the queue, the same contract as the audit row. */
  async pausedTenantIds(): Promise<Set<string>> {
    try {
      const admin = this.supabaseClientFactory.createAdmin();
      const { data, error } = await admin
        .from('report_queue_pauses')
        .select('tenant_id, paused, paused_until')
        .eq('paused', true);
      if (error) {
        throw error;
      }
      return new Set(
        ((data ?? []) as Array<{
          tenant_id: string;
          paused_until: string | null;
        }>)
          .filter(
            (row) =>
              row.paused_until == null ||
              new Date(row.paused_until).getTime() > Date.now(),
          )
          .map((row) => row.tenant_id),
      );
    } catch (err) {
      this.logger.error('Failed to read the paused tenants:', { err });
      return new Set<string>();
    }
  }

  /** Pauses the caller's tenant — minutes present = timed pause, absent =
   *  indefinitely (until someone resumes). */
  async pause(
    user: RequestUser,
    minutes: number | null,
  ): Promise<ReportQueueState> {
    const tenantId = requireTenant(user);
    const admin = this.supabaseClientFactory.createAdmin();
    const now = new Date().toISOString();
    const pausedUntil = minutes
      ? new Date(Date.now() + minutes * 60_000).toISOString()
      : null;
    const { error } = await admin
      .from('report_queue_pauses')
      .upsert({
        tenant_id: tenantId,
        paused: true,
        paused_until: pausedUntil,
        paused_by: user.userId,
        paused_at: now,
        updated_at: now,
      });
    if (error) {
      this.logger.error('Failed to pause the report queue:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to pause the report queue',
      });
    }
    return {
      paused: true,
      pausedUntil: pausedUntil,
      pausedBy: user.userId,
      pausedAt: now,
    };
  }

  /** Ends the pause — the tenant's claims resume on the next tick. */
  async resume(user: RequestUser): Promise<ReportQueueState> {
    const tenantId = requireTenant(user);
    const admin = this.supabaseClientFactory.createAdmin();
    const { error } = await admin
      .from('report_queue_pauses')
      .upsert({
        tenant_id: tenantId,
        paused: false,
        paused_until: null,
        updated_at: new Date().toISOString(),
      });
    if (error) {
      this.logger.error('Failed to resume the report queue:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to resume the report queue',
      });
    }
    return {
      paused: false,
      pausedUntil: null,
      pausedBy: null,
      pausedAt: null,
    };
  }

  private async readRow(tenantId: string | undefined): Promise<PauseRow | null> {
    const admin = this.supabaseClientFactory.createAdmin();
    const { data, error } = await admin
      .from('report_queue_pauses')
      .select('tenant_id, paused, paused_until, paused_by, paused_at')
      .eq('tenant_id', tenantId)
      .maybeSingle<PauseRow>();
    if (error) {
      this.logger.error('Failed to read the report queue pause:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to read the report queue state',
      });
    }
    return data ?? null;
  }
}

/** No active company membership → the queue controls (and even the status
 *  read) have no company to act on. */
function requireTenant(user: RequestUser): string {
  if (!user.tenantId) {
    throw new BadRequestException({
      error_code: ErrorCode.VALIDATION_ERROR,
      message: 'Company setup required before using the report queue',
    });
  }
  return user.tenantId;
}

/** An expired timed pause reads as "running" — the truth the panel and the
 *  worker both need. */
function normalise(row: PauseRow): ReportQueueState {
  const paused =
    row.paused &&
    (row.paused_until == null ||
      new Date(row.paused_until).getTime() > Date.now());
  return {
    paused,
    pausedUntil: paused ? row.paused_until : null,
    pausedBy: paused ? row.paused_by : null,
    pausedAt: paused ? row.paused_at : null,
  };
}
