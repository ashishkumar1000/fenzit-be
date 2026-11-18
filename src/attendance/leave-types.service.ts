import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { PgPoolFactory } from '../common/pg/pg-pool.factory';
import { ErrorCode } from '../common/enums/error-code.enum';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import {
  internalError,
  requireTenant,
  writeAuditRpc,
} from './attendance-rpc.helpers';
import { leaveNotFound } from './leave.model';
import { assertPayrollDatesEditable } from './payroll-date-gate';
import {
  LeaveTypeView,
  PatchLeaveTypeValuesDto,
  SetLeaveRequestTypeDto,
} from './dto/leave-type.dto';

/** One catalog row as stored (numeric days arrive as text). */
interface LeaveTypeRow {
  id: string;
  tenant_id: string;
  code: string | null;
  name: string;
  accrual_mode: string | null;
  /** PostgREST answers a numeric as a JSON number; the pg-tx read as text. */
  accrual_days: string | number;
  carry_forward: boolean;
  allow_over_balance: boolean;
  paid: boolean;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

// The PostgREST select string. PostgREST strips inner whitespace, so a
// `::text as alias` cast parses as a bogus type name — and its alias
// grammar cannot follow a cast either. Plain `accrual_days` arrives as a
// JSON number (the view Number()-wraps it); the pg-tx queries use real SQL
// and keep their `::text as` casts.
const LEAVE_TYPE_COLUMNS =
  'id, tenant_id, code, name, accrual_mode, accrual_days, carry_forward, allow_over_balance, paid, enabled, created_at, updated_at';

/** How a catalog answer reads on the wire. */
export function toLeaveTypeView(row: LeaveTypeRow): LeaveTypeView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    accrualMode: row.accrual_mode,
    accrualDays: Number(row.accrual_days),
    carryForward: row.carry_forward,
    allowOverBalance: row.allow_over_balance,
    paid: row.paid,
    enabled: row.enabled,
    configurable: row.code !== null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The FIXED leave-type catalog (23-13): every company carries exactly
 * Earned Leave, Sick Leave, Bereavement and Comp-Off — types cannot be
 * created or deleted, and names, codes and accrual modes are inherent.
 * The owner edits VALUES only (rate/grant, carry-forward, over-balance,
 * paid, enabled). Rows that predate the fixed catalog and matched no
 * code are read-only remnants (code NULL, never enabled). Zero database
 * functions: every read and write is a guarded table statement with an
 * explicit tenant filter, and each mutation writes one `write_audit_row`
 * entry carrying the changed-field names and old/new pairs.
 */
@Injectable()
export class LeaveTypesService {
  private readonly logger = new Logger(LeaveTypesService.name);

  constructor(
    private readonly supabaseFactory: SupabaseClientFactory,
    private readonly pg: PgPoolFactory,
  ) {}

  /** The owner's catalog view: the fixed four plus any legacy remnants. */
  async list(user: RequestUser): Promise<LeaveTypeView[]> {
    const tenantId = requireTenant(user);
    const { data, error } = await this.supabaseFactory
      .createAdmin()
      .from('leave_types')
      .select(LEAVE_TYPE_COLUMNS)
      .eq('tenant_id', tenantId)
      .order('name', { ascending: true });
    if (error) {
      this.logger.error('Failed to list the leave types:', { error });
      throw internalError('Failed to list the leave types');
    }
    return ((data ?? []) as unknown as LeaveTypeRow[]).map(toLeaveTypeView);
  }

  /** The employee catalog: enabled types only, Comp-Off included (the app
   *  renders its "owner approves" shape from accrualMode none). */
  async listEnabled(user: RequestUser): Promise<LeaveTypeView[]> {
    const tenantId = requireTenant(user);
    const { data, error } = await this.supabaseFactory
      .createAdmin()
      .from('leave_types')
      .select(LEAVE_TYPE_COLUMNS)
      .eq('tenant_id', tenantId)
      .eq('enabled', true)
      .order('name', { ascending: true });
    if (error) {
      this.logger.error('Failed to list the enabled leave types:', { error });
      throw internalError('Failed to list the leave types');
    }
    return ((data ?? []) as unknown as LeaveTypeRow[]).map(toLeaveTypeView);
  }

  /**
   * Values-only PATCH. Name, code and accrual mode are absent from the
   * DTO — the global pipe silently strips such body keys, so a rename
   * attempt lands as the no-change answer with no audit and nothing
   * non-editable can persist.
   */
  async patchValues(
    user: RequestUser,
    id: string,
    dto: PatchLeaveTypeValuesDto,
  ): Promise<LeaveTypeView> {
    const tenantId = requireTenant(user);
    const admin = this.supabaseFactory.createAdmin();

    const row = await this.readTypeRow(admin, tenantId, id);
    if (row.code === null) {
      throw notConfigurable();
    }
    // The mode rules (the DB checks are the backstop): mode-none types
    // have no accrual to configure; carry-forward and the over-balance
    // escape are monthly-only knobs.
    if (
      dto.accrualDays !== undefined &&
      dto.accrualDays > 0 &&
      row.accrual_mode === 'none'
    ) {
      throw modeRule('This leave type has no accrual to configure');
    }
    if (dto.carryForward === true && row.accrual_mode !== 'monthly') {
      throw modeRule('Only monthly-accruing leave can carry forward');
    }
    if (dto.allowOverBalance === true && row.accrual_mode !== 'monthly') {
      throw modeRule(
        'Only monthly-accruing leave can allow over-balance applies',
      );
    }

    const updates: Record<string, string | boolean | number> = {};
    const changedFields: string[] = [];
    const oldValues: Record<string, unknown> = {};
    const newValues: Record<string, unknown> = {};
    const track = (
      column: string,
      next: string | boolean | number,
      current: string | boolean | number,
    ): void => {
      if (next === current) return;
      updates[column] = next;
      changedFields.push(column);
      oldValues[column] = current;
      newValues[column] = next;
    };
    if (dto.accrualDays !== undefined) {
      track('accrual_days', dto.accrualDays, Number(row.accrual_days));
    }
    if (dto.carryForward !== undefined) {
      track('carry_forward', dto.carryForward, row.carry_forward);
    }
    if (dto.allowOverBalance !== undefined) {
      track('allow_over_balance', dto.allowOverBalance, row.allow_over_balance);
    }
    if (dto.paid !== undefined) {
      track('paid', dto.paid, row.paid);
    }
    if (dto.enabled !== undefined) {
      track('enabled', dto.enabled, row.enabled);
    }
    if (changedFields.length === 0) {
      return toLeaveTypeView(row);
    }
    // No updated_at trigger exists (the zero-functions boundary forbids one),
    // so the service stamps the column on every real change.
    updates['updated_at'] = new Date().toISOString();

    const { data: updated, error } = await admin
      .from('leave_types')
      .update(updates)
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select(LEAVE_TYPE_COLUMNS)
      .single<LeaveTypeRow>();
    if (error) {
      if (error.code === 'PGRST116') {
        // The type vanished between this read and the write.
        throw typeNotFound();
      }
      this.logger.error('Failed to update the leave type:', { error });
      throw internalError('Failed to update the leave type');
    }

    await this.writeAudit(
      admin,
      user.userId,
      tenantId,
      'leave.type_updated',
      null,
      {
        changed_fields: changedFields,
        old: oldValues,
        new: newValues,
      },
    );
    return toLeaveTypeView(updated);
  }

  /**
   * Types (or un-types — null clears back to the untyped = paid default) one
   * existing request. The request id is the leave row's own id, the same one
   * the owner list hands back.
   *
   * 23-9 (the 23-7 follow-up's ledgered debt, closed here): the paid marking
   * is what a locked month's run consumed — re-typing a frozen date would
   * rewrite that input. The gate and the write now run as ONE transaction
   * (the gate holds its shared advisory locks to commit, so no lock decision
   * can land between check and write), on the same restructure the
   * apply/approve paths got in the 23-7 follow-up.
   *
   * 23-13: the swap holds the target employee's advisory lock — a re-type
   * moves a type bucket, so it must serialise against the apply-time balance
   * check and the credit path like every other balance-mutating write. It
   * performs NO balance check by design (the owner's correction tool for
   * mis-typed leave; consumption re-derives). A legacy remnant or a disabled
   * type cannot be SET on a request; a request already carrying one may keep
   * it (no-op) or be re-typed off it.
   */
  async setRequestType(
    user: RequestUser,
    requestId: string,
    dto: SetLeaveRequestTypeDto,
  ): Promise<{
    requestId: string;
    employeeId: string;
    leaveTypeId: string | null;
    paid: boolean;
  }> {
    const tenantId = requireTenant(user);
    const admin = this.supabaseFactory.createAdmin();

    const result = await this.pg.withTransaction(async (tx) => {
      const reqRes = await tx.query<{
        id: string;
        tenant_id: string;
        employee_id: string;
        leave_type_id: string | null;
      }>(
        `select id, tenant_id, employee_id, leave_type_id
           from public.leave_requests
          where id = $1::uuid and tenant_id = $2::uuid`,
        [requestId, tenantId],
      );
      const request = reqRes.rows[0];
      if (!request) throw leaveNotFound();

      // The per-employee write lock (reentrant — the apply path's own lock
      // is already gone by the time an owner re-types).
      await tx.query('select public.attendance_lock_employee($1)', [
        request.employee_id,
      ]);

      const datesRes = await tx.query<{ leave_date: string }>(
        `select leave_date::text as leave_date
           from public.leave_request_days
          where leave_request_id = $1::uuid
          order by leave_date asc`,
        [requestId],
      );
      const dates = datesRes.rows.map((r) => r.leave_date);

      const readType = async (id: string): Promise<LeaveTypeRow> => {
        const res = await tx.query<LeaveTypeRow>(
          `select id, tenant_id, name, code, accrual_mode, accrual_days::text as accrual_days,
                  carry_forward, allow_over_balance, paid, enabled,
                  created_at::text as created_at, updated_at::text as updated_at
             from public.leave_types
            where id = $1::uuid and tenant_id = $2::uuid`,
          [id, tenantId],
        );
        if (!res.rows[0]) throw typeNotFound();
        return res.rows[0];
      };

      const currentType =
        request.leave_type_id === null
          ? null
          : await readType(request.leave_type_id);

      let newTypeId = request.leave_type_id;
      let newType: LeaveTypeRow | null = currentType;
      if (dto.leaveTypeId !== undefined) {
        if (dto.leaveTypeId === null) {
          newTypeId = null;
          newType = null;
        } else if (currentType === null || currentType.id !== dto.leaveTypeId) {
          const target = await readType(dto.leaveTypeId);
          if (target.code === null || !target.enabled) {
            throw typeUnavailable();
          }
          newType = target;
          newTypeId = target.id;
        }
      }

      // NULL reads as paid, so the audit and the answer state the marking the
      // run will act on — the effective one, not just the raw flag.
      const oldPaid = currentType === null ? true : currentType.paid;
      const newPaid = newType === null ? true : newType.paid;
      if (newTypeId === request.leave_type_id) {
        // AD-6 own retry: a no-op re-type answers the current marking —
        // audits nothing and never trips the date gate.
        return {
          requestId: request.id,
          employeeId: request.employee_id,
          leaveTypeId: request.leave_type_id,
          paid: oldPaid,
          oldPaid,
          changed: false,
        };
      }

      // The frozen-date gate, inside the write tx (23-9).
      await assertPayrollDatesEditable(tx, tenantId, dates, 'retyped');

      try {
        const updated = await tx.query<{
          id: string;
          employee_id: string;
          leave_type_id: string | null;
        }>(
          `update public.leave_requests
              set leave_type_id = $1::uuid, updated_at = now()
            where id = $2::uuid and tenant_id = $3::uuid
            returning id, employee_id, leave_type_id`,
          [newTypeId, requestId, tenantId],
        );
        if (updated.rows.length === 0) throw leaveNotFound();
        return {
          requestId: updated.rows[0].id,
          employeeId: updated.rows[0].employee_id,
          leaveTypeId: updated.rows[0].leave_type_id,
          paid: newPaid,
          oldPaid,
          changed: true,
        };
      } catch (e: unknown) {
        if (this.isForeignKeyViolation(e)) {
          // The chosen type was deleted while this typing was in flight.
          throw new ConflictException({
            error_code: ErrorCode.LEAVE_TYPE_CHANGED,
            message:
              'The chosen leave type is no longer available — reload and try again',
          });
        }
        throw e;
      }
    });

    // Best-effort, post-commit: an audit failure never undoes the typing —
    // and a no-op re-type audits nothing (the AD-6 retry writes nothing).
    if (result.changed !== true) {
      return {
        requestId: result.requestId,
        employeeId: result.employeeId,
        leaveTypeId: result.leaveTypeId,
        paid: result.paid,
      };
    }
    await this.writeAudit(
      admin,
      user.userId,
      tenantId,
      'leave.request_typed',
      result.employeeId,
      {
        changed_fields: ['leave_type_id'],
        old_paid: result.oldPaid,
        new_paid: result.paid,
      },
    );
    return {
      requestId: result.requestId,
      employeeId: result.employeeId,
      leaveTypeId: result.leaveTypeId,
      paid: result.paid,
    };
  }

  /** A pg FK violation (23xxx family; typing cares about 23503 — the chosen
   *  type row vanished while the write was in flight). */
  private isForeignKeyViolation(e: unknown): boolean {
    return (
      typeof e === 'object' &&
      e !== null &&
      typeof (e as { code?: string }).code === 'string' &&
      (e as { code: string }).code.startsWith('23503')
    );
  }

  /** The row, or the plain-English 404 for anything outside this company. */
  private async readTypeRow(
    admin: ReturnType<SupabaseClientFactory['createAdmin']>,
    tenantId: string,
    id: string,
  ): Promise<LeaveTypeRow> {
    const { data, error } = await admin
      .from('leave_types')
      .select(LEAVE_TYPE_COLUMNS)
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle<LeaveTypeRow>();
    if (error) {
      this.logger.error('Failed to read the leave type:', { error });
      throw internalError('Failed to read the leave type');
    }
    if (!data) throw typeNotFound();
    return data;
  }

  /**
   * The audit entry names what changed and the old/new pairs — never the
   * type names. Best-effort: a failed entry logs and moves on, never
   * undoing the save.
   */
  private async writeAudit(
    admin: ReturnType<SupabaseClientFactory['createAdmin']>,
    actorId: string,
    tenantId: string,
    action: string,
    targetUserId: string | null,
    details: Record<string, unknown>,
  ): Promise<void> {
    await writeAuditRpc(admin, this.logger, 'leave-type', {
      actorId,
      tenantId,
      action,
      targetUserId,
      details,
    });
  }
}

function notConfigurable(): ConflictException {
  return new ConflictException({
    error_code: ErrorCode.LEAVE_TYPE_NOT_CONFIGURABLE,
    message:
      'This is a legacy leave type kept read-only — its values cannot be edited',
  });
}

function modeRule(message: string): UnprocessableEntityException {
  return new UnprocessableEntityException({
    error_code: ErrorCode.VALIDATION_ERROR,
    message,
  });
}

function typeUnavailable(): UnprocessableEntityException {
  return new UnprocessableEntityException({
    error_code: ErrorCode.LEAVE_TYPE_DISABLED,
    message:
      'This leave type is not available — it is disabled or a legacy type kept read-only',
  });
}

function typeNotFound(): NotFoundException {
  return new NotFoundException({
    error_code: ErrorCode.RESOURCE_NOT_FOUND,
    message: 'The leave type is not in this company',
  });
}
