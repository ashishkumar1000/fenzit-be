import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { PgPoolFactory } from '../common/pg/pg-pool.factory';
import { payrollRunAdvisoryKey } from '../common/pg/advisory-keys';
import { ErrorCode } from '../common/enums/error-code.enum';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { isMonthKey } from './effective-dating';
import {
  internalError,
  requireTenant,
  validationError,
  writeAuditRow,
} from './payroll.helpers';
import { LockView } from './dto/payroll-lock.dto';

interface LockRow {
  month: string;
  locked_by: string;
  locked_at: string;
  confirmation: Record<string, unknown>;
}

/**
 * The permanent month lock (CAP-9): a completed month can be locked, and a
 * lock has no unlock in v1. A month that never completed a run (no runs, or
 * only failed ones — zero payslips) cannot be locked ("run payroll first");
 * a month with a run still queued or running cannot either (the lock would
 * freeze payslips the run is about to replace). The confirmation echoes the
 * permanence copy, the off-cycle remedy, and the staged off-cycle lines the
 * month still carries (23-9 lists them — by lock time each is an orphan the
 * admin can re-target to an unlocked month)
 * the month carries. Zero database functions.
 */
@Injectable()
export class PayrollLockService {
  private readonly logger = new Logger(PayrollLockService.name);

  constructor(
    private readonly supabaseFactory: SupabaseClientFactory,
    private readonly pg: PgPoolFactory,
  ) {}

  /** The gate the other payroll services consult (enqueue, month status). */
  async isLocked(tenantId: string, month: string): Promise<boolean> {
    const { data, error } = await this.supabaseFactory
      .createAdmin()
      .from('payroll_month_locks')
      .select('month')
      .eq('tenant_id', tenantId)
      .eq('month', month)
      .maybeSingle<LockRow>();
    if (error) {
      this.logger.error('Failed to read the month lock:', { error });
      throw internalError('Failed to read the payroll lock state');
    }
    return data !== null;
  }

  async lock(user: RequestUser, month: string): Promise<LockView> {
    const tenantId = requireTenant(user);
    if (!isMonthKey(month)) {
      throw validationError('month must be a real month written as YYYY-MM');
    }

    // The decide+insert runs as ONE transaction holding the month's
    // payroll-run advisory key EXCLUSIVELY — the same key the run engine's
    // payslip-write transaction takes and the attendance date gate holds
    // shared. That order makes every interleaving safe: no run can enqueue
    // past the run read below and execute against a locked month (the engine
    // re-probes the lock inside its write tx), and no correction can commit
    // between this decision and the lock insert.
    const row = await this.pg.withTransaction(async (tx) => {
      await tx.query(
        `select pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
        [payrollRunAdvisoryKey(tenantId, month)],
      );

      // Re-lock is a 409 naming the permanence, not a silent 200.
      const existing = await tx.query<{ month: string }>(
        `select month from public.payroll_month_locks
          where tenant_id = $1::uuid and month = $2`,
        [tenantId, month],
      );
      if (existing.rows.length > 0) {
        throw new ConflictException({
          error_code: ErrorCode.PAYROLL_MONTH_LOCKED,
          message: `${month} is already locked — a lock is permanent and cannot be undone`,
        });
      }

      // A run still in flight must finish first: the lock would freeze the
      // payslips the run is about to replace.
      const runs = await tx.query<{ status: string }>(
        `select status from public.payroll_runs
          where tenant_id = $1::uuid and month = $2`,
        [tenantId, month],
      );
      const statuses = runs.rows.map((r) => r.status);
      if (statuses.includes('queued') || statuses.includes('running')) {
        throw new ConflictException({
          error_code: ErrorCode.PAYROLL_RUN_IN_PROGRESS,
          message: `the ${month} run is still in progress — wait for it to finish, then lock; if it seems stuck, re-running the month reclaims it`,
        });
      }
      if (!statuses.includes('completed')) {
        // Never ran, or every run failed (zero payslips): there is nothing
        // to make final yet.
        throw new ConflictException({
          error_code: ErrorCode.PAYROLL_MONTH_NOT_RUN,
          message: `${month} has no completed payroll run yet — run payroll first, then lock`,
        });
      }

      // The remedy line LISTS what the month already owes off-cycle (23-9):
      // every staged line by lock time is one the completed run did not
      // consume — orphaned, and re-targetable to an unlocked month.
      const stagedRes = await tx.query<{
        label: string;
        amount: string;
        tag: string;
        employee_name: string | null;
      }>(
        `select l.label, l.amount::text as amount, l.tag, u.name as employee_name
           from public.payroll_off_cycle_lines l
           join public.memberships m on m.id = l.membership_id
           join public.users u on u.id = m.user_id
          where l.tenant_id = $1::uuid and l.month = $2 and l.status = 'staged'
          order by l.created_at asc, l.id asc`,
        [tenantId, month],
      );
      const stagedLines = stagedRes.rows.map((r) => ({
        employee: r.employee_name ?? 'unknown employee',
        label: r.label,
        amount: r.amount,
        tag: r.tag,
      }));

      const confirmation = {
        statement: `${month}'s payroll is now final — its payslips, deductions and attendance can no longer change`,
        permanence:
          'A lock cannot be undone — there is no unlock. Re-running the month and editing its payslips are refused from now on.',
        remedy:
          'If something is missing after the lock, stage it as an off-cycle line on the NEXT open month — a locked month cannot take new lines, but the next run can carry the money.',
        stagedOffCycleLines: stagedLines,
      };
      const inserted = await tx.query<LockRow>(
        `insert into public.payroll_month_locks
           (tenant_id, month, locked_by, confirmation)
         values ($1::uuid, $2, $3::uuid, $4::jsonb)
         on conflict (tenant_id, month) do nothing
         returning month, locked_by, locked_at, confirmation`,
        [tenantId, month, user.userId, JSON.stringify(confirmation)],
      );
      if (inserted.rows.length === 0) {
        // A concurrent lock won the (tenant_id, month) PK: answer the
        // winner's state instead of failing.
        throw new ConflictException({
          error_code: ErrorCode.PAYROLL_MONTH_LOCKED,
          message: `${month} is already locked — a lock is permanent and cannot be undone`,
        });
      }
      return inserted.rows[0];
    });

    // Best-effort, post-commit: an audit failure never undoes the lock.
    await writeAuditRow(
      this.supabaseFactory.createAdmin(),
      this.logger,
      'month lock',
      {
        actorId: user.userId,
        tenantId,
        action: 'payroll.month_locked',
        targetUser: null,
        details: { month },
      },
    );
    return this.toView(row);
  }

  /** The one month's lock — 404 while unlocked (month-status carries the
   *  boolean for the UI). */
  async get(user: RequestUser, month: string): Promise<LockView> {
    const tenantId = requireTenant(user);
    if (!isMonthKey(month)) {
      throw validationError('month must be a real month written as YYYY-MM');
    }
    const { data, error } = await this.supabaseFactory
      .createAdmin()
      .from('payroll_month_locks')
      .select('month, locked_by, locked_at, confirmation')
      .eq('tenant_id', tenantId)
      .eq('month', month)
      .maybeSingle<LockRow>();
    if (error) {
      this.logger.error('Failed to read the month lock:', { error });
      throw internalError('Failed to load the payroll lock');
    }
    if (!data) {
      throw new NotFoundException({
        error_code: ErrorCode.RESOURCE_NOT_FOUND,
        message: `${month} is not locked`,
      });
    }
    return this.toView(data);
  }

  private toView(row: LockRow): LockView {
    return {
      month: row.month,
      lockedAt: row.locked_at,
      lockedBy: row.locked_by,
      confirmation: row.confirmation ?? {},
    };
  }
}
