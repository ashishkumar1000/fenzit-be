import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { ErrorCode } from '../common/enums/error-code.enum';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { internalError, requireTenant } from './attendance-rpc.helpers';
import { leaveNotFound } from './leave.model';
import {
  CreateLeaveTypeDto,
  LeaveTypeView,
  SetLeaveRequestTypeDto,
  UpdateLeaveTypeDto,
} from './dto/leave-type.dto';

/** One catalog row as stored. */
interface LeaveTypeRow {
  id: string;
  tenant_id: string;
  name: string;
  paid: boolean;
  created_at: string;
  updated_at: string;
}

interface LeaveRequestTypingRow {
  id: string;
  tenant_id: string;
  employee_id: string;
  leave_type_id: string | null;
}

const LEAVE_TYPE_COLUMNS = 'id, tenant_id, name, paid, created_at, updated_at';

/** How a create/update/delete/typing answer reads on the wire. */
export function toLeaveTypeView(row: LeaveTypeRow): LeaveTypeView {
  return {
    id: row.id,
    name: row.name,
    paid: row.paid,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The confirmed create-time default (owner, 2026-11-17): names containing
 * the words unpaid or LOP default to UNPAID, everything else — casual,
 * sick, earned, and any name matching no keyword — defaults to PAID. Both
 * keywords are word-scoped (a compound that merely contains the letters is
 * not a match), and an explicit `paid` in the body always wins.
 */
export function defaultPaidMarking(name: string): boolean {
  const normalised = name.toLowerCase();
  const hasWord = (keyword: string): boolean =>
    new RegExp(`(^|[^a-z])${keyword}([^a-z]|$)`).test(normalised);
  if (hasWord('unpaid') || hasWord('lop')) {
    return false;
  }
  return true;
}

/**
 * The paid/unpaid leave-type catalog (CAP-12) and the typing of existing
 * requests. Config rows are mutable: a payroll run resolves the marking at
 * execution time, so a reclassification reaches the next run unchanged —
 * nothing snapshots here. Zero database functions: every read and write is a
 * guarded table statement with an explicit tenant filter, and each mutation
 * writes one `write_audit_row` entry carrying changed-field names and the
 * old/new paid flag only (never the names).
 */
@Injectable()
export class LeaveTypesService {
  private readonly logger = new Logger(LeaveTypesService.name);

  constructor(private readonly supabaseFactory: SupabaseClientFactory) {}

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

  async create(
    user: RequestUser,
    dto: CreateLeaveTypeDto,
  ): Promise<LeaveTypeView & { appliedDefault?: 'paid' | 'unpaid' }> {
    const tenantId = requireTenant(user);
    const admin = this.supabaseFactory.createAdmin();
    const name = dto.name.trim();
    const defaulted = dto.paid === undefined || dto.paid === null;
    const paid = defaulted ? defaultPaidMarking(name) : (dto.paid as boolean);

    await this.refuseDuplicateName(admin, tenantId, name, null);
    const conflict = () =>
      new ConflictException({
        error_code: ErrorCode.DUPLICATE_RESOURCE,
        message: `A leave type called "${name}" already exists in your company`,
      });

    const { data, error } = await admin
      .from('leave_types')
      .insert({ tenant_id: tenantId, name, paid })
      .select(LEAVE_TYPE_COLUMNS)
      .single<LeaveTypeRow>();
    if (error) {
      if (error.code === '23505') throw conflict();
      this.logger.error('Failed to create the leave type:', { error });
      throw internalError('Failed to create the leave type');
    }

    await this.writeAudit(
      admin,
      user.userId,
      tenantId,
      'leave.type_created',
      null,
      { changed_fields: ['name', 'paid'], new_paid: data.paid },
    );
    const view = toLeaveTypeView(data);
    return defaulted
      ? { ...view, appliedDefault: paid ? 'paid' : 'unpaid' }
      : view;
  }

  async update(
    user: RequestUser,
    id: string,
    dto: UpdateLeaveTypeDto,
  ): Promise<LeaveTypeView> {
    const tenantId = requireTenant(user);
    const admin = this.supabaseFactory.createAdmin();

    const row = await this.readTypeRow(admin, tenantId, id);

    // No clear verb on either field: null (or a name that trims empty) is a
    // refused edit, not a removal — a catalog entry is renamed or re-marked.
    if (dto.name === null) {
      throw notClearable('name cannot be removed — rename the type instead');
    }
    if (dto.paid === null) {
      throw notClearable('paid must be true or false — it cannot be cleared');
    }
    const newName =
      dto.name === undefined ? undefined : dto.name.trim() || null;
    if (newName === null) {
      throw notClearable('name must not be empty or whitespace');
    }

    const updates: Record<string, string | boolean> = {};
    const changedFields: string[] = [];
    if (newName !== undefined && newName !== row.name) {
      await this.refuseDuplicateName(admin, tenantId, newName, id);
      updates['name'] = newName;
      changedFields.push('name');
    }
    if (dto.paid !== undefined && dto.paid !== row.paid) {
      updates['paid'] = dto.paid;
      changedFields.push('paid');
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
      if (error.code === '23505') {
        throw new ConflictException({
          error_code: ErrorCode.DUPLICATE_RESOURCE,
          message: `A leave type called "${updates['name']}" already exists in your company`,
        });
      }
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
        old_paid: row.paid,
        new_paid: updated.paid,
      },
    );
    return toLeaveTypeView(updated);
  }

  async remove(user: RequestUser, id: string): Promise<void> {
    const tenantId = requireTenant(user);
    const admin = this.supabaseFactory.createAdmin();
    const row = await this.readTypeRow(admin, tenantId, id);

    // A type that requests still reference cannot go: the run joins requests
    // to their type, so the references must be retyped first. The foreign
    // key's RESTRICT is the backstop for a race between probe and delete.
    const inUse = () =>
      new ConflictException({
        error_code: ErrorCode.LEAVE_TYPE_IN_USE,
        message:
          'This leave type is used by existing leave requests and cannot be deleted',
      });
    const { data: references, error: probeError } = await admin
      .from('leave_requests')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('leave_type_id', id)
      .limit(1);
    if (probeError) {
      this.logger.error('Failed to probe the leave type references:', {
        error: probeError,
      });
      throw internalError('Failed to delete the leave type');
    }
    if ((references as Array<{ id: string }> | null)?.length) throw inUse();

    // The delete returns the rows it actually removed: a race that removed
    // the row first answers 404 and writes no audit entry.
    const { data: deletedRows, error } = await admin
      .from('leave_types')
      .delete()
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select('id');
    if (error) {
      if (error.code === '23503') throw inUse();
      this.logger.error('Failed to delete the leave type:', { error });
      throw internalError('Failed to delete the leave type');
    }
    if (!(deletedRows as Array<{ id: string }> | null)?.length) {
      throw new NotFoundException({
        error_code: ErrorCode.RESOURCE_NOT_FOUND,
        message: 'The leave type is not in this company',
      });
    }

    await this.writeAudit(
      admin,
      user.userId,
      tenantId,
      'leave.type_deleted',
      null,
      { changed_fields: ['name', 'paid'], old_paid: row.paid },
    );
  }

  /**
   * Types (or un-types — null clears back to the untyped = paid default) one
   * existing request. The request id is the leave row's own id, the same one
   * the owner list hands back.
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

    const { data: request, error: requestError } = await admin
      .from('leave_requests')
      .select('id, tenant_id, employee_id, leave_type_id')
      .eq('id', requestId)
      .eq('tenant_id', tenantId)
      .maybeSingle<LeaveRequestTypingRow>();
    if (requestError) {
      this.logger.error('Failed to read the leave request:', {
        error: requestError,
      });
      throw internalError('Failed to set the leave type');
    }
    if (!request) throw leaveNotFound();

    const currentType =
      request.leave_type_id === null
        ? null
        : await this.readTypeRow(admin, tenantId, request.leave_type_id);

    let newTypeId = request.leave_type_id;
    let newType: LeaveTypeRow | null = currentType;
    if (dto.leaveTypeId !== undefined) {
      if (dto.leaveTypeId === null) {
        newTypeId = null;
        newType = null;
      } else if (currentType === null || currentType.id !== dto.leaveTypeId) {
        newType = await this.readTypeRow(admin, tenantId, dto.leaveTypeId);
        newTypeId = newType.id;
      }
    }

    // NULL reads as paid, so the audit and the answer state the marking the
    // run will act on — the effective one, not just the raw flag.
    const oldPaid = currentType === null ? true : currentType.paid;
    const newPaid = newType === null ? true : newType.paid;
    if (newTypeId === request.leave_type_id) {
      return {
        requestId: request.id,
        employeeId: request.employee_id,
        leaveTypeId: request.leave_type_id,
        paid: oldPaid,
      };
    }

    const { data: updated, error } = await admin
      .from('leave_requests')
      .update({ leave_type_id: newTypeId })
      .eq('id', requestId)
      .eq('tenant_id', tenantId)
      .select('id, tenant_id, employee_id, leave_type_id')
      .single<LeaveRequestTypingRow>();
    if (error) {
      if (error.code === 'PGRST116') throw leaveNotFound();
      if (error.code === '23503') {
        // The chosen type was deleted while this typing was in flight.
        throw new ConflictException({
          error_code: ErrorCode.LEAVE_TYPE_CHANGED,
          message:
            'The chosen leave type is no longer available — reload and try again',
        });
      }
      this.logger.error('Failed to set the leave type:', { error });
      throw internalError('Failed to set the leave type');
    }

    await this.writeAudit(
      admin,
      user.userId,
      tenantId,
      'leave.request_typed',
      request.employee_id,
      {
        changed_fields: ['leave_type_id'],
        old_paid: oldPaid,
        new_paid: newPaid,
      },
    );
    return {
      requestId: updated.id,
      employeeId: updated.employee_id,
      leaveTypeId: updated.leave_type_id,
      paid: newPaid,
    };
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

  /** Create and rename both stop here first; PATCH passes its own id to exclude itself. */
  private async refuseDuplicateName(
    admin: ReturnType<SupabaseClientFactory['createAdmin']>,
    tenantId: string,
    name: string,
    excludeId: string | null,
  ): Promise<void> {
    let probe = admin
      .from('leave_types')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('name', name);
    if (excludeId !== null) probe = probe.neq('id', excludeId);
    const { data: clash, error } = await probe.maybeSingle<{ id: string }>();
    if (error) {
      this.logger.error('Failed to probe the leave type name:', { error });
      throw internalError('Failed to save the leave type');
    }
    if (clash) {
      throw new ConflictException({
        error_code: ErrorCode.DUPLICATE_RESOURCE,
        message: `A leave type called "${name}" already exists in your company`,
      });
    }
  }

  /**
   * The audit entry names what changed and the paid flags — never the type
   * names. A failed entry must not undo the save, so both a resolved error
   * and a rejection (network) log and move on.
   */
  private async writeAudit(
    admin: ReturnType<SupabaseClientFactory['createAdmin']>,
    actorId: string,
    tenantId: string,
    action: string,
    targetUserId: string | null,
    details: Record<string, unknown>,
  ): Promise<void> {
    try {
      const auditCall = (await admin.rpc('write_audit_row', {
        p_actor: actorId,
        p_action: action,
        p_tenant_id: tenantId,
        p_target_user: targetUserId,
        p_details: details,
      })) as { error: { code?: string; message?: string } | null };
      if (auditCall.error) {
        this.logger.error('Failed to write the leave-type audit entry:', {
          error: auditCall.error,
        });
      }
    } catch (rejection: unknown) {
      this.logger.error('Failed to write the leave-type audit entry:', {
        error: rejection,
      });
    }
  }
}

function notClearable(message: string): UnprocessableEntityException {
  return new UnprocessableEntityException({
    error_code: ErrorCode.VALIDATION_ERROR,
    message,
  });
}

function typeNotFound(): NotFoundException {
  return new NotFoundException({
    error_code: ErrorCode.RESOURCE_NOT_FOUND,
    message: 'The leave type is not in this company',
  });
}
