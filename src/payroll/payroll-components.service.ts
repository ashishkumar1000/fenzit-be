import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { ErrorCode } from '../common/enums/error-code.enum';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import {
  internalError,
  requireTenant,
  validationError,
  writeAuditRow,
} from './payroll.helpers';
import {
  CreateSalaryComponentDto,
  SalaryComponentView,
  UpdateSalaryComponentDto,
} from './dto/payroll-components.dto';

/** One library row as stored. */
interface SalaryComponentRow {
  id: string;
  tenant_id: string;
  name: string;
  is_basic: boolean;
  active: boolean;
  created_at: string;
  updated_at: string;
}

const COMPONENT_COLUMNS =
  'id, tenant_id, name, is_basic, active, created_at, updated_at';

/** How a create/update answer reads on the wire. */
export function toComponentView(row: SalaryComponentRow): SalaryComponentView {
  return {
    id: row.id,
    name: row.name,
    isBasic: row.is_basic,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The employee-name list a refused deactivation shows: at most five names,
 *  then the exact outstanding count when the display read was truncated. */
export function employeeNameList(
  names: string[],
  total = names.length,
): string {
  const shown = names.slice(0, 5);
  if (total <= shown.length) return shown.join(', ');
  return `${shown.join(', ')} and ${total - shown.length} more`;
}

/**
 * The company salary component library (CAP-1). Exactly one component is the
 * basic one — the PF base and the Form V basic/DA line — enforced by the
 * service probe (which answers with the current basic's name) and backed by
 * the partial unique index `salary_components_tenant_basic_uq`, whose 23505
 * this service maps to the same refusal. Renames are legal whenever the new
 * name is free (a taken name is a 409) and reach the next run — structures
 * reference ids and payslips snapshot names at run time, so a rename never
 * rewrites pay history; deactivation is refused while any structure row of
 * the company still references the component, naming the employees. Zero
 * database functions: every read and write is a guarded table statement with
 * an explicit tenant filter, each mutation writes one audit entry.
 */
@Injectable()
export class PayrollComponentsService {
  private readonly logger = new Logger(PayrollComponentsService.name);

  constructor(private readonly supabaseFactory: SupabaseClientFactory) {}

  async list(user: RequestUser): Promise<SalaryComponentView[]> {
    const tenantId = requireTenant(user);
    const { data, error } = await this.supabaseFactory
      .createAdmin()
      .from('salary_components')
      .select(COMPONENT_COLUMNS)
      .eq('tenant_id', tenantId)
      .order('name', { ascending: true });
    if (error) {
      this.logger.error('Failed to list the salary components:', { error });
      throw internalError('Failed to list the salary components');
    }
    return ((data ?? []) as unknown as SalaryComponentRow[]).map(
      toComponentView,
    );
  }

  async create(
    user: RequestUser,
    dto: CreateSalaryComponentDto,
  ): Promise<SalaryComponentView> {
    const tenantId = requireTenant(user);
    const admin = this.supabaseFactory.createAdmin();
    const name = dto.name.trim();

    await this.refuseDuplicateName(admin, tenantId, name, null);
    if (dto.isBasic) {
      const currentBasic = await this.readBasicRow(admin, tenantId);
      if (currentBasic) {
        throw this.basicExistsError(currentBasic.name);
      }
    }

    const { data, error } = await admin
      .from('salary_components')
      .insert({
        tenant_id: tenantId,
        name,
        is_basic: dto.isBasic === true,
      })
      .select(COMPONENT_COLUMNS)
      .single<SalaryComponentRow>();
    if (error) {
      if (error.code === '23505') {
        if (isBasicIndexViolation(error)) {
          const current = await this.readBasicRow(admin, tenantId);
          throw this.basicExistsError(current?.name ?? 'Another component');
        }
        throw this.duplicateNameError(name);
      }
      this.logger.error('Failed to create the salary component:', { error });
      throw internalError('Failed to create the salary component');
    }

    await this.writeAudit(admin, user.userId, tenantId, {
      action: 'payroll.component_created',
      changedFields: dto.isBasic === true ? ['name', 'isBasic'] : ['name'],
    });
    return toComponentView(data);
  }

  async update(
    user: RequestUser,
    id: string,
    dto: UpdateSalaryComponentDto,
  ): Promise<SalaryComponentView> {
    const tenantId = requireTenant(user);
    const admin = this.supabaseFactory.createAdmin();

    const row = await this.readComponentRow(admin, tenantId, id);

    // No clear verb on any field: null is a refused edit, not a removal — a
    // component is renamed, re-flagged or deactivated.
    if (dto.name === null) {
      throw validationError(
        'name cannot be removed — rename the component instead',
      );
    }
    if (dto.isBasic === null) {
      throw validationError(
        'isBasic must be true or false — it cannot be cleared',
      );
    }
    if (dto.active === null) {
      throw validationError(
        'active must be true or false — it cannot be cleared',
      );
    }
    const newName =
      dto.name === undefined ? undefined : dto.name.trim() || null;
    if (newName === null) {
      throw validationError('name must not be empty or whitespace');
    }

    const updates: Record<string, string | boolean> = {};
    const changedFields: string[] = [];
    if (newName !== undefined && newName !== row.name) {
      await this.refuseDuplicateName(admin, tenantId, newName, id);
      updates['name'] = newName;
      changedFields.push('name');
    }
    if (dto.isBasic === true && !row.is_basic) {
      const currentBasic = await this.readBasicRow(admin, tenantId, id);
      if (currentBasic) {
        throw this.basicExistsError(currentBasic.name);
      }
    }
    if (dto.isBasic !== undefined && dto.isBasic !== row.is_basic) {
      updates['is_basic'] = dto.isBasic;
      changedFields.push('isBasic');
    }
    if (dto.active === false && row.active) {
      await this.refuseDeactivation(admin, tenantId, row.name, id);
    }
    if (dto.active !== undefined && dto.active !== row.active) {
      updates['active'] = dto.active;
      changedFields.push('active');
    }
    if (changedFields.length === 0) {
      return toComponentView(row);
    }
    // No updated_at trigger exists (the zero-functions boundary forbids one),
    // so the service stamps the column on every real change.
    updates['updated_at'] = new Date().toISOString();

    const { data: updated, error } = await admin
      .from('salary_components')
      .update(updates)
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select(COMPONENT_COLUMNS)
      .single<SalaryComponentRow>();
    if (error) {
      if (error.code === '23505') {
        if (isBasicIndexViolation(error)) {
          const current = await this.readBasicRow(admin, tenantId, id);
          throw this.basicExistsError(current?.name ?? 'Another component');
        }
        throw this.duplicateNameError(String(updates['name']));
      }
      if (error.code === 'PGRST116') {
        // The component vanished between this read and the write.
        throw componentNotFound();
      }
      this.logger.error('Failed to update the salary component:', { error });
      throw internalError('Failed to update the salary component');
    }

    await this.writeAudit(admin, user.userId, tenantId, {
      action: 'payroll.component_updated',
      changedFields,
    });
    return toComponentView(updated);
  }

  /** The row, or the plain-English 404 for anything outside this company. */
  private async readComponentRow(
    admin: ReturnType<SupabaseClientFactory['createAdmin']>,
    tenantId: string,
    id: string,
  ): Promise<SalaryComponentRow> {
    const { data, error } = await admin
      .from('salary_components')
      .select(COMPONENT_COLUMNS)
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle<SalaryComponentRow>();
    if (error) {
      this.logger.error('Failed to read the salary component:', { error });
      throw internalError('Failed to read the salary component');
    }
    if (!data) throw componentNotFound();
    return data;
  }

  /** The company's designated basic component, if one exists yet. */
  private async readBasicRow(
    admin: ReturnType<SupabaseClientFactory['createAdmin']>,
    tenantId: string,
    excludeId?: string,
  ): Promise<SalaryComponentRow | null> {
    let probe = admin
      .from('salary_components')
      .select(COMPONENT_COLUMNS)
      .eq('tenant_id', tenantId)
      .eq('is_basic', true);
    if (excludeId !== undefined) probe = probe.neq('id', excludeId);
    const { data, error } = await probe.maybeSingle<SalaryComponentRow>();
    if (error) {
      this.logger.error('Failed to read the basic component:', { error });
      throw internalError('Failed to save the salary component');
    }
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
      .from('salary_components')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('name', name);
    if (excludeId !== null) probe = probe.neq('id', excludeId);
    const { data: clash, error } = await probe.maybeSingle<{ id: string }>();
    if (error) {
      this.logger.error('Failed to probe the component name:', { error });
      throw internalError('Failed to save the salary component');
    }
    if (clash) throw this.duplicateNameError(name);
  }

  /**
   * Deactivation is refused while ANY structure row of the company references
   * the component — the answer lists the employees (capped), so the admin
   * knows exactly whose structure to fix first. The probe is a server-side
   * JSONB containment filter with an exact count, so its cost does not grow
   * with how many structures a company has and no row limit can silently
   * truncate the answer; only the first five referencing memberships are
   * read, for the display names. A structure save that slips in between this
   * probe and the update below leaves a deactivated-but-referenced component
   * behind — accepted and self-healing: the stored structure stays valid for
   * the run, and the next deactivation attempt refuses (the probe runs
   * before every attempt).
   */
  private async refuseDeactivation(
    admin: ReturnType<SupabaseClientFactory['createAdmin']>,
    tenantId: string,
    componentName: string,
    componentId: string,
  ): Promise<void> {
    const referenceFilter = () =>
      admin
        .from('salary_structures')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .contains('lines', JSON.stringify([{ componentId }]));
    const { count, error } = await referenceFilter();
    if (error) {
      this.logger.error('Failed to probe the structure references:', { error });
      throw internalError('Failed to update the salary component');
    }
    const references = count ?? 0;
    if (references > 0) {
      const { data: firstRows, error: rowsError } = await admin
        .from('salary_structures')
        .select('membership_id')
        .eq('tenant_id', tenantId)
        .contains('lines', JSON.stringify([{ componentId }]))
        .order('membership_id')
        .range(0, 4);
      if (rowsError) {
        this.logger.error('Failed to read the referencing structures:', {
          error: rowsError,
        });
        throw internalError('Failed to update the salary component');
      }
      const membershipIds = (firstRows ?? [])
        .map((row) => String(row.membership_id))
        .filter((id) => id.length > 0);
      const names = await this.employeeNamesFor(admin, tenantId, membershipIds);
      throw new ConflictException({
        error_code: ErrorCode.SALARY_COMPONENT_IN_USE,
        message: `"${componentName}" is part of the salary structure of ${employeeNameList(names, references)} — replace it in those structures before deactivating it`,
      });
    }
  }

  /** Employee display names for membership ids, tenant-scoped, ordered. */
  private async employeeNamesFor(
    admin: ReturnType<SupabaseClientFactory['createAdmin']>,
    tenantId: string,
    membershipIds: string[],
  ): Promise<string[]> {
    const { data, error } = await admin
      .from('memberships')
      .select('id, users!memberships_user_id_fkey(name)')
      .eq('tenant_id', tenantId)
      .in('id', membershipIds)
      .order('id');
    if (error) {
      this.logger.error('Failed to read the referencing employees:', { error });
      throw internalError('Failed to update the salary component');
    }
    const rows = (data ?? []) as unknown as Array<{
      id: string;
      users: { name: string } | null;
    }>;
    return rows.map((row) => row.users?.name ?? 'An employee');
  }

  private duplicateNameError(name: string): ConflictException {
    return new ConflictException({
      error_code: ErrorCode.DUPLICATE_RESOURCE,
      message: `A salary component called "${name}" already exists in your company`,
    });
  }

  private basicExistsError(currentName: string): ConflictException {
    return new ConflictException({
      error_code: ErrorCode.BASIC_COMPONENT_EXISTS,
      message: `"${currentName}" is already the basic component of your company — clear its basic designation first`,
    });
  }

  /**
   * The audit entry names what changed — never amounts or the component
   * name (the identifiers live on the row itself). A failed entry must not
   * undo the save, so both a resolved error and a rejection log and move on.
   */
  private async writeAudit(
    admin: ReturnType<SupabaseClientFactory['createAdmin']>,
    actorId: string,
    tenantId: string,
    entry: { action: string; changedFields: string[] },
  ): Promise<void> {
    await writeAuditRow(admin, this.logger, 'components', {
      actorId,
      tenantId,
      action: entry.action,
      targetUser: null,
      details: { changed_fields: entry.changedFields },
    });
  }
}

/**
 * The partial unique index `salary_components_tenant_basic_uq` backs the
 * probe-write race on the basic designation; its violation message carries
 * the constraint name.
 */
function isBasicIndexViolation(error: { message?: string }): boolean {
  return (error.message ?? '').includes('salary_components_tenant_basic_uq');
}

function componentNotFound(): NotFoundException {
  return new NotFoundException({
    error_code: ErrorCode.RESOURCE_NOT_FOUND,
    message: 'The salary component is not in your company',
  });
}
