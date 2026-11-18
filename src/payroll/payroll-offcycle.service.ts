import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { PgPoolFactory } from '../common/pg/pg-pool.factory';
import { payrollRunAdvisoryKey } from '../common/pg/advisory-keys';
import { ErrorCode } from '../common/enums/error-code.enum';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import {
  CreateOffCycleLineDto,
  OffCycleLineView,
  UpdateOffCycleLineDto,
} from './dto/payroll-offcycle.dto';
import { PayrollMonthStatusService } from './payroll-month-status.service';
import { PayrollLockService } from './payroll-lock.service';
import {
  internalError,
  requireTenant,
  validationError,
  writeAuditRow,
} from './payroll.helpers';

interface LineRow {
  id: string;
  membership_id: string;
  month: string;
  label: string;
  amount: string;
  tag: string;
  status: string;
  created_at: string;
}

/**
 * The off-cycle staging surface (CAP-10, story 23-9): company admins add a
 * one-off line for a specific employee in an unlocked month — a positive
 * earning (bonus, arrear, correction; wage tag joins the PF base) or a
 * negative recovery (server-side employer-liability acknowledgment). A line
 * is staged until a run lands it on the month's payslips; a line the run
 * skips stays staged — orphaned, listed in the run summary and the lock
 * confirmation, re-targetable to any unlocked month (staged-only edits).
 *
 * Serialization: create and update take the month's payroll-run advisory
 * key EXCLUSIVELY (the same key the run engine's write tx and the lock
 * service hold) — edits wait out an in-flight run's write instead of racing
 * it, and no staging can slip between a lock decision and its insert. The
 * engine's staged → applied flip works from the exact ids its computation
 * captured, so a line staged mid-run simply stays staged for the next run.
 * Zero database functions.
 */
@Injectable()
export class PayrollOffCycleService {
  private readonly logger = new Logger(PayrollOffCycleService.name);

  constructor(
    private readonly supabaseFactory: SupabaseClientFactory,
    private readonly pg: PgPoolFactory,
    private readonly monthStatus: PayrollMonthStatusService,
    private readonly lockService: PayrollLockService,
  ) {}

  async create(
    user: RequestUser,
    dto: CreateOffCycleLineDto,
  ): Promise<OffCycleLineView> {
    const tenantId = requireTenant(user);
    this.assertAmount(dto.amount, dto.acknowledged === true);
    this.assertLabel(dto.label);
    const employee = await this.validateTarget(
      user,
      tenantId,
      dto.month,
      dto.membershipId,
    );

    // The insert runs under the month's advisory key with the lock
    // re-checked inside — a lock decided concurrently wins cleanly.
    const created = await this.pg
      .withTransaction(async (tx) => {
        await tx.query(
          `select pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
          [payrollRunAdvisoryKey(tenantId, dto.month)],
        );
        await this.assertMonthUnlocked(tx, tenantId, dto.month);
        const res = await tx.query<LineRow>(
          `insert into public.payroll_off_cycle_lines
           (tenant_id, membership_id, month, label, amount, tag, acknowledged, created_by)
         values ($1::uuid, $2::uuid, $3, btrim($4), $5, $6, $7, $8::uuid)
         returning id, membership_id, month, label, amount, tag, status, created_at`,
          [
            tenantId,
            dto.membershipId,
            dto.month,
            dto.label,
            dto.amount.toFixed(2),
            dto.tag ?? 'bonus',
            dto.amount < 0,
            user.userId,
          ],
        );
        if (res.rows.length === 0) {
          throw internalError('Failed to stage the off-cycle line');
        }
        return res.rows[0];
      })
      .catch((e: unknown) => {
        if (this.isUniqueViolation(e)) {
          throw new ConflictException({
            error_code: ErrorCode.DUPLICATE_RESOURCE,
            message:
              'An off-cycle line with this label already exists for this employee and month',
          });
        }
        throw e;
      });

    // Best-effort, post-commit: an audit failure never undoes the staging.
    await writeAuditRow(
      this.supabaseFactory.createAdmin(),
      this.logger,
      'off-cycle staging',
      {
        actorId: user.userId,
        tenantId,
        action: 'payroll.offcycle_staged',
        targetUser: employee.userId,
        details: {
          month: dto.month,
          label: dto.label,
          amount: dto.amount,
          tag: dto.tag ?? 'bonus',
        },
      },
    );
    return this.toView(created, employee.name);
  }

  async list(user: RequestUser, month?: string): Promise<OffCycleLineView[]> {
    const tenantId = requireTenant(user);
    let query = this.supabaseFactory
      .createAdmin()
      .from('payroll_off_cycle_lines')
      .select(
        'id, membership_id, month, label, amount, tag, status, created_at',
      )
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(200);
    if (month) {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
        throw validationError('month must be a real month written as YYYY-MM');
      }
      query = query.eq('month', month);
    }
    const { data, error } = await query;
    if (error) {
      this.logger.error('Failed to read the off-cycle lines:', { error });
      throw internalError('Failed to load the off-cycle lines');
    }
    const rows = (data ?? []) as unknown as LineRow[];
    const names = await this.employeeNames(
      tenantId,
      rows.map((r) => r.membership_id),
    );
    return rows.map((r) => this.toView(r, names.get(r.membership_id) ?? null));
  }

  /**
   * Staged-only edits (CAP-10): re-target the month (the orphan remedy —
   * the CURRENT month may be locked, the target's state is what gates),
   * fix the amount/label/tag, or move the line to the right employee.
   * Applied lines are immutable — the money already sits on payslips.
   */
  async update(
    user: RequestUser,
    id: string,
    dto: UpdateOffCycleLineDto,
  ): Promise<OffCycleLineView> {
    const tenantId = requireTenant(user);
    const admin = this.supabaseFactory.createAdmin();
    const { data: line, error } = await admin
      .from('payroll_off_cycle_lines')
      .select(
        'id, membership_id, month, label, amount, tag, status, created_at',
      )
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle<LineRow>();
    if (error) {
      this.logger.error('Failed to read the off-cycle line:', { error });
      throw internalError('Failed to update the off-cycle line');
    }
    if (!line) {
      throw new NotFoundException({
        error_code: ErrorCode.RESOURCE_NOT_FOUND,
        message: 'No off-cycle line with that id in your company',
      });
    }
    if (line.status === 'applied') {
      // The house payroll validation answer (422): the request is valid
      // shape but the line is immutable — not a month-lock conflict.
      throw validationError(
        'This line already sits on its month payslips — stage a new line for any further change',
      );
    }

    const month = dto.month ?? line.month;
    const membershipId = dto.membershipId ?? line.membership_id;
    const amount = dto.amount ?? Number(line.amount);
    this.assertAmount(amount, dto.acknowledged === true);
    this.assertLabel(dto.label);
    const employee = await this.validateTarget(
      user,
      tenantId,
      month,
      membershipId,
    );

    // Both months the edit touches, keyed in sorted order (no deadlock),
    // exclusively: a re-target waits out both months' in-flight writes.
    const months = [...new Set([line.month, month])].sort();
    const updated = await this.pg
      .withTransaction(async (tx) => {
        for (const m of months) {
          await tx.query(
            `select pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
            [payrollRunAdvisoryKey(tenantId, m)],
          );
        }
        // Re-read under the keys: the line may have been consumed while the
        // reads above ran.
        const fresh = await tx.query<{ status: string }>(
          `select status from public.payroll_off_cycle_lines
          where id = $1::uuid and tenant_id = $2::uuid`,
          [id, tenantId],
        );
        if (fresh.rows.length === 0) {
          throw new NotFoundException({
            error_code: ErrorCode.RESOURCE_NOT_FOUND,
            message: 'No off-cycle line with that id in your company',
          });
        }
        if (fresh.rows[0].status !== 'staged') {
          throw validationError(
            'This line already sits on its month payslips — stage a new line for any further change',
          );
        }
        await this.assertMonthUnlocked(tx, tenantId, month);
        const res = await tx.query<LineRow>(
          `update public.payroll_off_cycle_lines
            set membership_id = $2::uuid, month = $3, label = btrim($4),
                amount = $5, tag = $6, acknowledged = $7, updated_at = now()
          where id = $1::uuid and tenant_id = $8::uuid
          returning id, membership_id, month, label, amount, tag, status, created_at`,
          [
            id,
            membershipId,
            month,
            dto.label ?? line.label,
            amount.toFixed(2),
            dto.tag ?? line.tag,
            amount < 0,
            tenantId,
          ],
        );
        if (res.rows.length === 0) {
          throw new NotFoundException({
            error_code: ErrorCode.RESOURCE_NOT_FOUND,
            message: 'No off-cycle line with that id in your company',
          });
        }
        return res.rows[0];
      })
      .catch((e: unknown) => {
        if (this.isUniqueViolation(e)) {
          throw new ConflictException({
            error_code: ErrorCode.DUPLICATE_RESOURCE,
            message:
              'An off-cycle line with this label already exists for this employee and month',
          });
        }
        throw e;
      });

    // Best-effort, post-commit: an audit failure never undoes the edit.
    await writeAuditRow(
      this.supabaseFactory.createAdmin(),
      this.logger,
      'off-cycle edit',
      {
        actorId: user.userId,
        tenantId,
        action: 'payroll.offcycle_updated',
        targetUser: employee.userId,
        details: { id, month, label: updated.label, amount },
      },
    );
    return this.toView(updated, employee.name);
  }

  /** Zero rejected; a negative line is a recovery and needs the
   *  employer-liability acknowledgment — enforced server-side. A label that
   *  trims to nothing would die on the DDL's btrim check as an unmapped
   *  23514 — refuse it here in plain English. */
  private assertAmount(amount: number, acknowledged: boolean): void {
    if (amount === 0) {
      throw validationError(
        'an off-cycle amount cannot be zero — use a positive earning or a negative recovery',
      );
    }
    if (amount < 0 && !acknowledged) {
      throw validationError(
        'a negative (recovery) line needs the employer-liability acknowledgment — confirm you accept the liability before saving it',
      );
    }
  }

  private assertLabel(label: string | undefined): void {
    if (label !== undefined && label.trim().length === 0) {
      throw validationError('label is required');
    }
  }

  /** The shared month + employee validation: the current open month or an
   *  earlier unlocked month within the runnable bound; the employee an
   *  ACTIVE employee-role membership with an effective structure for the
   *  month (month-start resolution, the same read the run engine uses). */
  private async validateTarget(
    user: RequestUser,
    tenantId: string,
    month: string,
    membershipId: string,
  ): Promise<{ userId: string; name: string | null }> {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      throw validationError('month must be a real month written as YYYY-MM');
    }
    const today = await this.tenantToday(tenantId);
    if (month > today.slice(0, 7)) {
      throw validationError(
        `${month} has not started yet — off-cycle lines target the current open month or an earlier one`,
      );
    }
    const status = await this.monthStatus.monthStatus(user, month);
    if (status.firstPayrollMonth !== null && month < status.firstPayrollMonth) {
      throw validationError(status.notRunnableReason ?? '');
    }

    const admin = this.supabaseFactory.createAdmin();
    const { data: membership, error: memberError } = await admin
      .from('memberships')
      .select('id, user_id, users!memberships_user_id_fkey(name)')
      .eq('id', membershipId)
      .eq('tenant_id', tenantId)
      .eq('role', 'employee')
      .eq('status', 'active')
      .maybeSingle<{
        id: string;
        user_id: string;
        users: { name: string | null } | null;
      }>();
    if (memberError) {
      this.logger.error('Failed to read the membership:', {
        error: memberError,
      });
      throw internalError('Failed to stage the off-cycle line');
    }
    if (!membership) {
      throw validationError(
        'the employee must be an active employee of your company',
      );
    }
    const { data: structure, error: structureError } = await admin
      .from('salary_structures')
      .select('effective_from')
      .eq('membership_id', membershipId)
      .eq('tenant_id', tenantId)
      .lte('effective_from', `${month}-01`)
      .order('effective_from', { ascending: false })
      .limit(1);
    if (structureError) {
      this.logger.error('Failed to read the salary structures:', {
        error: structureError,
      });
      throw internalError('Failed to stage the off-cycle line');
    }
    if (
      !structure ||
      (structure as Array<{ effective_from: string }>).length === 0
    ) {
      throw validationError(
        `no salary structure is effective for ${month} — set one up first`,
      );
    }
    const nameRow = membership as unknown as {
      user_id: string;
      users: { name: string | null } | null;
    };
    return { userId: nameRow.user_id, name: nameRow.users?.name ?? null };
  }

  /** The lock re-check, under the advisory key (the lock service takes the
   *  same key for its decide+insert, so this cannot read stale). */
  private async assertMonthUnlocked(
    tx: PoolClient,
    tenantId: string,
    month: string,
  ): Promise<void> {
    const res = await tx.query<{ month: string }>(
      `select month from public.payroll_month_locks
        where tenant_id = $1::uuid and month = $2`,
      [tenantId, month],
    );
    if (res.rows.length > 0) {
      throw new ConflictException({
        error_code: ErrorCode.PAYROLL_MONTH_LOCKED,
        message: `${month} is locked for payroll — off-cycle lines cannot target it`,
      });
    }
  }

  private async employeeNames(
    tenantId: string,
    membershipIds: string[],
  ): Promise<Map<string, string | null>> {
    if (membershipIds.length === 0) return new Map();
    const { data, error } = await this.supabaseFactory
      .createAdmin()
      .from('memberships')
      .select('id, users!memberships_user_id_fkey(name)')
      .eq('tenant_id', tenantId)
      .in('id', membershipIds);
    if (error) {
      this.logger.error('Failed to read the membership names:', { error });
      return new Map();
    }
    const names = new Map<string, string | null>();
    for (const row of (data ?? []) as unknown as Array<{
      id: string;
      users: { name: string | null } | null;
    }>) {
      names.set(row.id, row.users?.name ?? null);
    }
    return names;
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

  private isUniqueViolation(e: unknown): boolean {
    return (
      typeof e === 'object' &&
      e !== null &&
      (e as { code?: string }).code === '23505'
    );
  }

  private toView(row: LineRow, employeeName: string | null): OffCycleLineView {
    return {
      id: row.id,
      membershipId: row.membership_id,
      employeeName,
      month: row.month,
      label: row.label,
      amount: Number(row.amount),
      tag: row.tag as 'wage' | 'bonus',
      status: row.status as 'staged' | 'applied',
      createdAt: row.created_at,
    };
  }
}
