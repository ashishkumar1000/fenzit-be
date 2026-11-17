import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { ErrorCode } from '../common/enums/error-code.enum';
import {
  internalError,
  requireTenant,
  validationError,
  writeAuditRow,
} from './payroll.helpers';
import { isMonthKey, resolveEffective } from './effective-dating';
import { moneyText } from './formula';
import {
  DeductionHeadView,
  FLAT_AMOUNT_SHAPE,
  HeadBasis,
  HeadKind,
  PERCENT_SHAPE,
  PutDeductionHeadDto,
} from './dto/payroll-deductions.dto';

interface HeadRow {
  id: string;
  name: string;
  kind: string;
  amount: string;
  basis: string | null;
  effective_from: string;
  active: boolean;
  updated_at: string;
}

const HEAD_COLUMNS =
  'id, name, kind, amount, basis, effective_from, active, updated_at';

/** One resolved head for a run month (kind, amount, earned basis). */
export interface ResolvedHead {
  name: string;
  kind: HeadKind;
  amount: string;
  basis: HeadBasis | null;
}

/**
 * Deduction heads (CAP-6): company-level flat or percentage heads,
 * effective-dated per month-start like every payroll policy setting. A
 * percentage computes on the EARNED basis amount for the period — the run
 * engine supplies that; this service owns the config and the resolution.
 * A same-name same-date save REPLACES the revision; an identical re-save of
 * an active revision writes nothing (and re-enacts a retired one). Zero
 * database functions.
 */
@Injectable()
export class DeductionHeadsService {
  private readonly logger = new Logger(DeductionHeadsService.name);

  constructor(private readonly supabaseFactory: SupabaseClientFactory) {}

  /** Every dated head revision, oldest date first within each name. */
  async list(user: RequestUser): Promise<DeductionHeadView[]> {
    const tenantId = requireTenant(user);
    const { data, error } = await this.supabaseFactory
      .createAdmin()
      .from('payroll_deduction_heads')
      .select(HEAD_COLUMNS)
      .eq('tenant_id', tenantId)
      .order('name', { ascending: true })
      .order('effective_from', { ascending: true });
    if (error) {
      this.logger.error('Failed to list the deduction heads:', { error });
      throw internalError('Failed to load the deduction heads');
    }
    return ((data ?? []) as unknown as HeadRow[]).map(toHeadView);
  }

  async save(
    user: RequestUser,
    dto: PutDeductionHeadDto,
  ): Promise<DeductionHeadView> {
    const tenantId = requireTenant(user);
    const admin = this.supabaseFactory.createAdmin();

    this.validate(dto);
    // Normalise both kinds to the money text form so the no-op compare and
    // the stored row are canonical ("2" and "2.00" are the same head).
    const stored = {
      name: dto.name,
      kind: dto.kind,
      amount: moneyText(Number(dto.amount)),
      basis: dto.kind === 'percent' ? (dto.basis ?? null) : null,
    };

    const { data: existing, error: existingError } = await admin
      .from('payroll_deduction_heads')
      .select(HEAD_COLUMNS)
      .eq('tenant_id', tenantId)
      .eq('name', dto.name)
      .eq('effective_from', dto.effectiveFrom)
      .maybeSingle<HeadRow>();
    if (existingError) {
      this.logger.error('Failed to read the existing head revision:', {
        error: existingError,
      });
      throw internalError('Failed to save the deduction head');
    }
    if (
      existing &&
      existing.active === true &&
      existing.kind === stored.kind &&
      existing.amount === stored.amount &&
      existing.basis === stored.basis
    ) {
      return toHeadView(existing);
    }

    const { data: row, error } = await admin
      .from('payroll_deduction_heads')
      .upsert(
        {
          tenant_id: tenantId,
          name: stored.name,
          kind: stored.kind,
          amount: stored.amount,
          basis: stored.basis,
          effective_from: dto.effectiveFrom,
          active: true,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'tenant_id,name,effective_from' },
      )
      .select(HEAD_COLUMNS)
      .single<HeadRow>();
    if (error) {
      this.logger.error('Failed to save the deduction head:', { error });
      throw internalError('Failed to save the deduction head');
    }

    await writeAuditRow(admin, this.logger, 'head', {
      actorId: user.userId,
      tenantId,
      action: 'payroll.head_saved',
      targetUser: null,
      details: {
        name: stored.name,
        kind: stored.kind,
        amount: stored.amount,
        basis: stored.basis,
        effective_from: dto.effectiveFrom,
        ...(existing
          ? {
              previous: {
                kind: existing.kind,
                amount: existing.amount,
                basis: existing.basis,
                active: existing.active,
              },
            }
          : {}),
      },
    });
    return toHeadView(row);
  }

  /**
   * Retire one dated revision (the run engine drops it from the months it
   * governs). An identical re-save of a retired revision re-enacts it —
   * that is the way back; a new dated revision of the same name also works.
   */
  async deactivate(
    user: RequestUser,
    headId: string,
    confirm: boolean,
  ): Promise<DeductionHeadView> {
    const tenantId = requireTenant(user);
    if (!confirm) {
      throw validationError(
        'confirm must be true — deactivation has no undo; an identical re-save of the retired revision (or a new dated one) is the way back',
      );
    }
    const admin = this.supabaseFactory.createAdmin();

    const { data: row, error } = await admin
      .from('payroll_deduction_heads')
      .update({ active: false, updated_at: new Date().toISOString() })
      .eq('tenant_id', tenantId)
      .eq('id', headId)
      .eq('active', true)
      .select(HEAD_COLUMNS)
      .maybeSingle<HeadRow>();
    if (error) {
      this.logger.error('Failed to deactivate the deduction head:', { error });
      throw internalError('Failed to deactivate the deduction head');
    }
    if (!row) {
      // Either never existed, belongs to another company, or is already
      // retired — the same answer for all three: not found.
      throw new NotFoundException({
        error_code: ErrorCode.RESOURCE_NOT_FOUND,
        message: 'No active deduction head with that id in your company',
      });
    }

    await writeAuditRow(admin, this.logger, 'head', {
      actorId: user.userId,
      tenantId,
      action: 'payroll.head_deactivated',
      targetUser: null,
      details: {
        name: row.name,
        effective_from: row.effective_from,
      },
    });
    return toHeadView(row);
  }

  private validate(dto: PutDeductionHeadDto): void {
    if (!dto.name.trim()) {
      throw validationError('name must not be empty');
    }
    if (dto.kind !== 'flat' && dto.kind !== 'percent') {
      throw validationError('kind must be flat or percent');
    }
    if (dto.kind === 'percent') {
      if (!dto.basis) {
        throw validationError(
          'a percentage head needs a basis — the earned basic or the post-LOP gross it applies to',
        );
      }
      if (!PERCENT_SHAPE.test(dto.amount)) {
        throw validationError(
          'a percentage head amount must be between 0 (exclusive) and 100 (inclusive), with at most 2 decimals',
        );
      }
      if (!(Number(dto.amount) > 0)) {
        throw validationError(
          'a percentage head amount must be between 0 (exclusive) and 100 (inclusive), with at most 2 decimals',
        );
      }
      return;
    }
    if (dto.basis !== undefined) {
      throw validationError(
        'a flat head applies its amount directly — only a percentage head carries a basis',
      );
    }
    if (!FLAT_AMOUNT_SHAPE.test(dto.amount)) {
      throw validationError(
        'a flat head amount must be money text — digits with at most 2 decimals ("200" or "200.00")',
      );
    }
    if (!(Number(dto.amount) > 0)) {
      throw validationError('a flat head amount must be more than zero');
    }
  }
}

function toHeadView(row: HeadRow): DeductionHeadView {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as HeadKind,
    amount: row.amount,
    basis: (row.basis as HeadBasis | null) ?? null,
    effectiveFrom: row.effective_from,
    active: row.active,
    updatedAt: row.updated_at,
  };
}

/**
 * The heads that govern a run month: per name, the latest revision whose
 * effective date is on/before the month's first day (month-start resolution)
 * that is still active — NO fallback to an earlier active revision when the
 * governing one is retired. Consumed by the run engine.
 */
export function resolveHeadsForMonth(
  rows: Array<Record<string, unknown>>,
  month: string,
): ResolvedHead[] {
  // A malformed month would lexically resolve the wrong revision — refuse
  // loudly, the same contract pfWageCeiling keeps.
  if (!isMonthKey(month)) {
    throw new Error(
      'resolveHeadsForMonth needs a real month written as YYYY-MM',
    );
  }
  const byName = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) {
    const name = String(row['name']);
    const bucket = byName.get(name);
    if (bucket) bucket.push(row);
    else byName.set(name, [row]);
  }
  const resolved: ResolvedHead[] = [];
  for (const [name, revisions] of byName) {
    const row = resolveEffective(
      revisions.map((r) => ({
        effectiveFrom: String(r['effective_from']),
        kind: r['kind'],
        amount: r['amount'],
        basis: r['basis'],
        active: r['active'],
      })),
      month,
    );
    // Fail closed: a row that does not positively say active drops out, so
    // a caller whose SELECT forgot the active column can never resurrect a
    // retired head.
    if (!row || row.active !== true) continue;
    resolved.push({
      name,
      kind: row.kind as HeadKind,
      amount: String(row.amount),
      basis: (row.basis as HeadBasis | null) ?? null,
    });
  }
  // Deterministic order for the run engine and the tests: by name (a plain
  // codepoint compare — locale rules differ across runtimes).
  return resolved.sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
}
