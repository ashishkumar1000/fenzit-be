import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { PgPoolFactory } from '../common/pg/pg-pool.factory';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { ErrorCode } from '../common/enums/error-code.enum';
import { isMonthKey } from './effective-dating';
import {
  CALENDAR_DEFAULTS,
  PayrollMonthStatusService,
} from './payroll-month-status.service';
import {
  internalError,
  requireTenant,
  validationError,
} from './payroll.helpers';
import { PostPayrollRunDto, PayrollRunView } from './dto/payroll-run.dto';
import { PayrollRunEngineService } from './payroll-run-engine.service';

interface RunRow {
  id: string;
  month: string;
  status: string;
  summary: Record<string, unknown> | null;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string | null;
}

const RUN_COLUMNS =
  'id, month, status, summary, error_message, started_at, finished_at, created_at';

const STALE_RUNNING_MS = 15 * 60 * 1000;

/**
 * The run lifecycle (CAP-3): the owner enqueues a month, the engine executes
 * it in-process, the status polls. Acceptance gates — the first-payroll-month
 * bound, the future, and the cut-off day (tenant time) — each refuse in plain
 * English with zero payslips written. A queued or running run for the month
 * is returned as-is (idempotent enqueue); a stale running row (an executor
 * that died) is reclaimed so the retry path never wedges.
 */
@Injectable()
export class PayrollRunService {
  private readonly logger = new Logger(PayrollRunService.name);

  constructor(
    private readonly supabaseFactory: SupabaseClientFactory,
    private readonly pg: PgPoolFactory,
    private readonly engine: PayrollRunEngineService,
    private readonly monthStatus: PayrollMonthStatusService,
  ) {}

  async enqueue(
    user: RequestUser,
    dto: PostPayrollRunDto,
  ): Promise<PayrollRunView> {
    const tenantId = requireTenant(user);
    if (!isMonthKey(dto.month)) {
      throw validationError('month must be a real month written as YYYY-MM');
    }
    const admin = this.supabaseFactory.createAdmin();

    // The bound: refuse only a month BEFORE the first payroll month. A
    // company with no join dates yet has no bound — the run itself answers
    // the no_employees completion (the fixture's zero-employee company).
    const status = await this.monthStatus.monthStatus(user, dto.month);
    if (
      status.firstPayrollMonth !== null &&
      dto.month < status.firstPayrollMonth
    ) {
      throw validationError(status.notRunnableReason ?? '');
    }

    // The cut-off day gate (tenant time): the run opens on the month's
    // resolved cut-off day, never before.
    const today = await this.tenantToday(tenantId);
    if (today < `${dto.month}-01`) {
      throw validationError(
        `${dto.month} has not started yet — runs open once the month has begun`,
      );
    }
    if (today.slice(0, 7) === dto.month) {
      const dayOfMonth = Number(today.slice(8, 10));
      const cutoff =
        (await this.resolvedCutoff(tenantId, dto.month)) ??
        CALENDAR_DEFAULTS.cutoffDay;
      if (dayOfMonth < cutoff) {
        throw validationError(
          `the ${dto.month} run opens on day ${cutoff} of the month (the attendance cut-off) — today is day ${dayOfMonth}`,
        );
      }
    }

    // Idempotent enqueue + stale reclaim.
    const existing = await admin
      .from('payroll_runs')
      .select(RUN_COLUMNS)
      .eq('tenant_id', tenantId)
      .eq('month', dto.month)
      .in('status', ['queued', 'running'])
      .order('created_at', { ascending: false })
      .maybeSingle<RunRow>();
    if (existing.error) {
      this.logger.error('Failed to read the existing runs:', {
        error: existing.error,
      });
      throw internalError('Failed to start the payroll run');
    }
    if (existing.data) {
      const row = existing.data;
      // A wedged run (the executor died) must never block the month
      // forever: a running run stale past the lease, or a queued run that
      // was never claimed, is failed so the retry path can proceed.
      const staleRunning =
        row.status === 'running' &&
        row.started_at !== null &&
        Date.now() - new Date(row.started_at).getTime() > STALE_RUNNING_MS;
      const staleQueued =
        row.status === 'queued' &&
        row.created_at !== null &&
        Date.now() - new Date(row.created_at).getTime() > STALE_RUNNING_MS;
      if (staleRunning || staleQueued) {
        await admin
          .from('payroll_runs')
          .update({
            status: 'failed',
            finished_at: new Date().toISOString(),
            error_message:
              'the run executor stopped before finishing — re-run to retry',
            updated_at: new Date().toISOString(),
          })
          .eq('id', row.id)
          .eq('status', row.status);
      } else {
        return this.toView(row);
      }
    }

    const { data: run, error } = await admin
      .from('payroll_runs')
      .insert({
        tenant_id: tenantId,
        month: dto.month,
        status: 'queued',
        initiated_by: user.userId,
      })
      .select(RUN_COLUMNS)
      .single<RunRow>();
    if (error) {
      // The partial unique (one ACTIVE run per tenant-month) raced a
      // concurrent enqueue: return the winner instead of failing.
      if (error.code === '23505') {
        const winner = await admin
          .from('payroll_runs')
          .select(RUN_COLUMNS)
          .eq('tenant_id', tenantId)
          .eq('month', dto.month)
          .in('status', ['queued', 'running'])
          .maybeSingle<RunRow>();
        if (winner.data) {
          return this.toView(winner.data);
        }
      }
      this.logger.error('Failed to enqueue the run:', { error });
      throw internalError('Failed to start the payroll run');
    }

    // Fire-and-forget: the executor claims the row itself (queued → running)
    // and reports completed|failed; the API answers as soon as it is queued.
    void this.engine
      .executeRun(run.id, tenantId, dto.month)
      .catch((e: unknown) => {
        this.logger.error(
          `Run ${run.id} executor exited with an error: ${e instanceof Error ? e.message : 'unknown'}`,
        );
      });

    return this.toView(run);
  }

  async status(user: RequestUser, runId: string): Promise<PayrollRunView> {
    const tenantId = requireTenant(user);
    const { data, error } = await this.supabaseFactory
      .createAdmin()
      .from('payroll_runs')
      .select(RUN_COLUMNS)
      .eq('tenant_id', tenantId)
      .eq('id', runId)
      .maybeSingle<RunRow>();
    if (error) {
      this.logger.error('Failed to read the run:', { error });
      throw internalError('Failed to load the payroll run');
    }
    if (!data) {
      throw new NotFoundException({
        error_code: ErrorCode.RESOURCE_NOT_FOUND,
        message: 'No payroll run with that id in your company',
      });
    }
    return this.toView(data);
  }

  async list(user: RequestUser): Promise<PayrollRunView[]> {
    const tenantId = requireTenant(user);
    const { data, error } = await this.supabaseFactory
      .createAdmin()
      .from('payroll_runs')
      .select(RUN_COLUMNS)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) {
      this.logger.error('Failed to list the runs:', { error });
      throw internalError('Failed to load the payroll runs');
    }
    return ((data ?? []) as unknown as RunRow[]).map((r) => this.toView(r));
  }

  private toView(row: RunRow): PayrollRunView {
    return {
      id: row.id,
      month: row.month,
      status: row.status,
      summary: row.summary ?? null,
      errorMessage: row.error_message,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    };
  }

  private async tenantToday(tenantId: string): Promise<string> {
    return this.pg.withTransaction(async (tx) => {
      const res = await tx.query<{ today: string }>(
        `select (now() at time zone (select timezone from public.tenants where id = $1::uuid))::date::text as today`,
        [tenantId],
      );
      return res.rows[0]?.today ?? '';
    });
  }

  private async resolvedCutoff(
    tenantId: string,
    month: string,
  ): Promise<number | null> {
    const { data, error } = await this.supabaseFactory
      .createAdmin()
      .from('payroll_calendar')
      .select('effective_from, cutoff_day')
      .eq('tenant_id', tenantId)
      .lte('effective_from', `${month}-01`)
      .order('effective_from', { ascending: true });
    if (error) {
      this.logger.error('Failed to read the calendar for the cut-off gate:', {
        error,
      });
      throw internalError('Failed to start the payroll run');
    }
    const row = (
      (data ?? []) as Array<{ effective_from: string; cutoff_day: number }>
    ).at(-1);
    return row?.cutoff_day ?? null;
  }
}
