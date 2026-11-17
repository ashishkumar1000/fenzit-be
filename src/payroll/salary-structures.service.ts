import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { ErrorCode } from '../common/enums/error-code.enum';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import {
  internalError,
  requireTenant,
  validationError,
} from './payroll.helpers';
import {
  evaluateStructure,
  moneyText,
  parseFormulaShape,
  StructureLineInput,
  FormulaNode,
  MAX_STRUCTURE_LINES,
} from './formula';
import {
  PutSalaryStructureDto,
  SalaryStructureLineView,
  SalaryStructureView,
} from './dto/salary-structures.dto';

/** A structure row as stored. */
interface SalaryStructureRow {
  id: string;
  tenant_id: string;
  membership_id: string;
  effective_from: string;
  lines: unknown;
  created_at: string;
  updated_at: string;
}

interface MembershipRow {
  id: string;
  user_id: string;
}

interface LibraryComponentRow {
  id: string;
  name: string;
  is_basic: boolean;
  active: boolean;
}

/** One validated, storable line: amount (exact text) XOR formula AST. */
export interface StoredLine {
  componentId: string;
  amount?: string;
  formula?: FormulaNode;
}

const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Exact decimal money text: up to 12 integer digits, at most 2 decimals.
 *  12 digits keeps the Number() evaluation exact well inside 2^53, so a
 *  stored amount and its computed echo can never disagree by a paise. */
const AMOUNT_SHAPE = /^\d{1,12}(\.\d{1,2})?$/;

const STRUCTURE_COLUMNS =
  'id, tenant_id, membership_id, effective_from, lines, created_at, updated_at';

/** Amount text normalised for the no-op compare, so "020000.00" and
 *  "20000.00" — the same money — do not read as a change. */
function normalisedForCompare(
  lines: StoredLine[],
): Array<Record<string, unknown>> {
  return lines.map((line) =>
    line.amount !== undefined
      ? {
          componentId: line.componentId,
          amount: moneyText(Number(line.amount)),
        }
      : { componentId: line.componentId, formula: line.formula },
  );
}

/** Key-order-insensitive JSON, for the identical-resave no-op check. */
function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (typeof v === 'object' && v !== null) {
      return Object.keys(v)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = sort((v as Record<string, unknown>)[key]);
          return acc;
        }, {});
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

/**
 * Per-employee effective-dated salary structures (CAP-2). A structure is a
 * dated revision: the one in effect for a run month is the latest
 * effective_from <= that month's first day (month-start resolution — a
 * mid-month-dated revision is first used by the NEXT month's run). A
 * same-date save REPLACES that dated row (upsert on the unique pair): the
 * dated row is the configuration for every month it governs, and locked
 * months keep run-time snapshots, so replacing config never rewrites pay
 * history. Lines are validated fully before anything is stored — component
 * ownership, amount XOR formula, formula shape, operand closure, cycles
 * (naming the chain), zero-operand division, negative results, and the
 * company's basic component must be present. Zero database functions: every
 * read and write is a guarded table statement with an explicit tenant
 * filter.
 */
@Injectable()
export class SalaryStructuresService {
  private readonly logger = new Logger(SalaryStructuresService.name);

  constructor(private readonly supabaseFactory: SupabaseClientFactory) {}

  /** The employee's dated revisions, oldest first, names resolved at read. */
  async list(
    user: RequestUser,
    memberUserId: string,
  ): Promise<SalaryStructureView[]> {
    const tenantId = requireTenant(user);
    const admin = this.supabaseFactory.createAdmin();

    const membership = await this.readMembershipRow(
      admin,
      tenantId,
      memberUserId,
    );
    const library = await this.readLibrary(admin, tenantId);

    const { data: rows, error } = await admin
      .from('salary_structures')
      .select(STRUCTURE_COLUMNS)
      .eq('tenant_id', tenantId)
      .eq('membership_id', membership.id)
      .order('effective_from', { ascending: true });
    if (error) {
      this.logger.error('Failed to list the salary structures:', { error });
      throw internalError('Failed to load the salary structures');
    }

    return ((rows ?? []) as unknown as SalaryStructureRow[]).map((row) =>
      this.toView(row, library),
    );
  }

  /**
   * Saves one dated revision (create, or replace the same-date revision).
   * Every validation runs against the save payload's own lines, so a
   * rejection never leaves a half-valid structure behind.
   */
  async save(
    user: RequestUser,
    memberUserId: string,
    dto: PutSalaryStructureDto,
  ): Promise<SalaryStructureView> {
    const tenantId = requireTenant(user);
    const admin = this.supabaseFactory.createAdmin();

    const membership = await this.readMembershipRow(
      admin,
      tenantId,
      memberUserId,
    );
    const library = await this.readLibrary(admin, tenantId);

    const storedJson: StoredLine[] = this.validateAndNormaliseLines(
      dto.lines,
      library,
    );

    // An identical re-save of the same dated revision writes nothing and
    // audits nothing (the employment-save precedent): the owner pressing
    // save twice must not manufacture a change trail.
    const { data: existing } = await admin
      .from('salary_structures')
      .select(STRUCTURE_COLUMNS)
      .eq('tenant_id', tenantId)
      .eq('membership_id', membership.id)
      .eq('effective_from', dto.effectiveFrom)
      .maybeSingle<SalaryStructureRow>();
    if (
      existing &&
      canonicalJson(existing.lines) ===
        canonicalJson(normalisedForCompare(storedJson))
    ) {
      return this.toView(existing, library);
    }

    const { data: row, error } = await admin
      .from('salary_structures')
      .upsert(
        {
          tenant_id: tenantId,
          membership_id: membership.id,
          effective_from: dto.effectiveFrom,
          lines: storedJson,
          // No trigger exists (the zero-functions boundary forbids one), so
          // the payload stamps the column itself: harmless on insert,
          // correct on the same-date replace, which otherwise keeps the
          // original updated_at while the answer reports it as fresh.
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'membership_id,effective_from' },
      )
      .select(STRUCTURE_COLUMNS)
      .single<SalaryStructureRow>();
    if (error) {
      // The unique (membership_id, effective_from) pair raced a concurrent
      // save of the same date: a 409 naming the date, never a raw 500.
      if (error.code === '23505') {
        throw validationError(
          `Another save of the ${dto.effectiveFrom} revision landed first — reload and try again`,
        );
      }
      if (error.code === 'PGRST116') {
        // The membership vanished between this read and the write.
        throw new NotFoundException({
          error_code: ErrorCode.RESOURCE_NOT_FOUND,
          message: 'The person is not a member of this company',
        });
      }
      this.logger.error('Failed to save the salary structure:', { error });
      throw internalError('Failed to save the salary structure');
    }

    await this.writeStructureAudit(admin, user.userId, tenantId, memberUserId, {
      action: 'payroll.structure_saved',
      effectiveFrom: dto.effectiveFrom,
      changedFields: ['lines'],
    });
    return this.toView(row, library);
  }

  // -- validation ---------------------------------------------------------

  /**
   * The full line-validation pipeline. Throws 422 with a plain-English
   * message on the first problem; returns the normalised stored lines
   * otherwise. Runs against the payload only — the request is judged on
   * what it carries, never on stored state.
   */
  private validateAndNormaliseLines(
    rawLines: unknown[],
    library: LibraryComponentRow[],
  ): StoredLine[] {
    if (!Array.isArray(rawLines) || rawLines.length === 0) {
      throw validationError(
        'A salary structure needs at least one component line',
      );
    }
    if (rawLines.length > MAX_STRUCTURE_LINES) {
      throw validationError(
        `A salary structure can have at most ${MAX_STRUCTURE_LINES} component lines`,
      );
    }

    const byId = new Map<string, LibraryComponentRow>(
      library.map((component) => [component.id, component]),
    );
    const seen = new Set<string>();
    const inputs: StructureLineInput[] = [];
    const stored: StoredLine[] = [];

    for (const raw of rawLines) {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw validationError('Each line must be an object with a componentId');
      }
      const record = raw as Record<string, unknown>;
      const componentId = record['componentId'];
      if (
        typeof componentId !== 'string' ||
        UUID_SHAPE.test(componentId) === false
      ) {
        throw validationError(
          'Each line needs the componentId of a component in your library',
        );
      }
      const component = byId.get(componentId);
      if (!component) {
        throw validationError(
          'A line references a component that is not in your company library',
        );
      }
      if (seen.has(componentId)) {
        throw validationError(
          `"${component.name}" appears twice in this structure — one line per component`,
        );
      }
      if (!component.active) {
        throw validationError(
          `"${component.name}" is deactivated — reactivate it before using it in a structure`,
        );
      }
      seen.add(componentId);

      const keys = Object.keys(record);
      const hasAmount = keys.includes('amount');
      const hasFormula = keys.includes('formula');
      if (hasAmount === hasFormula) {
        throw validationError(
          `The "${component.name}" line needs exactly one of an amount or a formula`,
        );
      }

      if (hasAmount) {
        const amount = record['amount'];
        if (typeof amount !== 'string' || !AMOUNT_SHAPE.test(amount)) {
          throw validationError(
            `The "${component.name}" amount must be ₹0 or more, written as a plain number of at most 12 digits with at most two decimal places (like "20000.00")`,
          );
        }
        inputs.push({
          componentId,
          name: component.name,
          amount: Number(amount),
        });
        stored.push({ componentId, amount });
        continue;
      }

      const parsed = parseFormulaShape(record['formula']);
      if (!parsed.ok) {
        throw validationError(
          `The "${component.name}" formula is not valid: ${parsed.message}`,
        );
      }
      inputs.push({
        componentId,
        name: component.name,
        formula: parsed.formula,
      });
      stored.push({ componentId, formula: parsed.formula });
    }

    const basic = library.find((component) => component.is_basic);
    if (!basic) {
      throw validationError(
        'Your company has no basic component yet — mark one component as basic before saving a structure',
      );
    }
    if (!seen.has(basic.id)) {
      throw validationError(
        `This structure does not pay "${basic.name}" — every structure must include the basic component`,
      );
    }

    const evaluation = evaluateStructure(inputs);
    if (!evaluation.ok) {
      throw validationError(evaluation.message);
    }
    return stored;
  }

  // -- reads --------------------------------------------------------------

  private async readMembershipRow(
    admin: ReturnType<SupabaseClientFactory['createAdmin']>,
    tenantId: string,
    memberUserId: string,
  ): Promise<MembershipRow> {
    const { data, error } = await admin
      .from('memberships')
      .select('id, user_id')
      .eq('tenant_id', tenantId)
      .eq('user_id', memberUserId)
      .maybeSingle<MembershipRow>();
    if (error) {
      this.logger.error('Failed to read the membership:', { error });
      throw internalError('Failed to load the salary structures');
    }
    if (!data) {
      throw new NotFoundException({
        error_code: ErrorCode.RESOURCE_NOT_FOUND,
        message: 'The person is not a member of this company',
      });
    }
    return data;
  }

  /** The whole library (names + basic + active flags) — a small config table. */
  private async readLibrary(
    admin: ReturnType<SupabaseClientFactory['createAdmin']>,
    tenantId: string,
  ): Promise<LibraryComponentRow[]> {
    const { data, error } = await admin
      .from('salary_components')
      .select('id, name, is_basic, active')
      .eq('tenant_id', tenantId);
    if (error) {
      this.logger.error('Failed to read the component library:', { error });
      throw internalError('Failed to load the salary structures');
    }
    return data ?? [];
  }

  /** One dated revision as the API answers it (computed amounts included). */
  private toView(
    row: SalaryStructureRow,
    library: LibraryComponentRow[],
  ): SalaryStructureView {
    const nameById = new Map(library.map((c) => [c.id, c.name]));
    const storedLines = Array.isArray(row.lines)
      ? (row.lines as StoredLine[])
      : [];
    const inputs: StructureLineInput[] = storedLines
      .filter((line) => typeof line?.componentId === 'string')
      .map((line) => ({
        componentId: line.componentId,
        name: nameById.get(line.componentId) ?? line.componentId,
        amount: line.amount !== undefined ? Number(line.amount) : undefined,
        formula: line.formula,
      }));
    // Stored rows passed this evaluation at save time and lines are
    // self-contained (references resolve inside the row), so it still
    // evaluates; a failure degrades the display instead of failing the read.
    const evaluation = evaluateStructure(inputs);

    const lines: SalaryStructureLineView[] = storedLines.map((line) => {
      const view: SalaryStructureLineView = {
        componentId: line.componentId,
        componentName: nameById.get(line.componentId) ?? 'A removed component',
      };
      if (line.amount !== undefined) {
        view.amount = line.amount;
        view.computedAmount = moneyText(Number(line.amount));
      } else {
        view.formula = line.formula;
        if (evaluation.ok) {
          const value = evaluation.values.get(line.componentId);
          if (value !== undefined) view.computedAmount = moneyText(value);
        }
      }
      return view;
    });

    return {
      effectiveFrom: row.effective_from,
      lines,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // -- audit --------------------------------------------------------------

  private async writeStructureAudit(
    admin: ReturnType<SupabaseClientFactory['createAdmin']>,
    actorId: string,
    tenantId: string,
    memberUserId: string,
    entry: { action: string; effectiveFrom: string; changedFields: string[] },
  ): Promise<void> {
    try {
      const auditCall = (await admin.rpc('write_audit_row', {
        p_actor: actorId,
        p_action: entry.action,
        p_tenant_id: tenantId,
        p_target_user: memberUserId,
        p_details: {
          changed_fields: entry.changedFields,
          effective_from: entry.effectiveFrom,
        },
      })) as { error: { code?: string; message?: string } | null };
      if (auditCall.error) {
        this.logger.error('Failed to write the structure audit entry:', {
          error: auditCall.error,
        });
      }
    } catch (rejection: unknown) {
      this.logger.error('Failed to write the structure audit entry:', {
        error: rejection,
      });
    }
  }
}
