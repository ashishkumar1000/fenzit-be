import { Injectable, Logger } from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { internalError, requireTenant, writeAuditRow } from './payroll.helpers';
import { isMonthKey, resolveEffective } from './effective-dating';
import {
  PayrollPfConfigView,
  PutPayrollPfConfigDto,
} from './dto/payroll-deductions.dto';

interface PfConfigRow {
  effective_from: string;
  covered: boolean;
  updated_at: string;
}

const PF_CONFIG_COLUMNS = 'effective_from, covered, updated_at';

/**
 * The tenant's PF-covered switch, effective-dated per month-start like every
 * payroll policy setting (CAP-6). Absent rows mean NOT covered — the switch
 * is off by default; a covered-on row's resolved month is the first-coverage
 * month, and an unlocked re-run of an earlier month resolves that month as
 * not covered even though the switch is on today. Zero database functions.
 */
@Injectable()
export class PayrollPfConfigService {
  private readonly logger = new Logger(PayrollPfConfigService.name);

  constructor(private readonly supabaseFactory: SupabaseClientFactory) {}

  /** The dated switch revisions, oldest first. */
  async list(user: RequestUser): Promise<PayrollPfConfigView[]> {
    const tenantId = requireTenant(user);
    const { data, error } = await this.supabaseFactory
      .createAdmin()
      .from('payroll_pf_config')
      .select(PF_CONFIG_COLUMNS)
      .eq('tenant_id', tenantId)
      .order('effective_from', { ascending: true });
    if (error) {
      this.logger.error('Failed to list the PF config:', { error });
      throw internalError('Failed to load the PF config');
    }
    return ((data ?? []) as unknown as PfConfigRow[]).map((row) => ({
      effectiveFrom: row.effective_from,
      covered: row.covered,
      updatedAt: row.updated_at,
    }));
  }

  async save(
    user: RequestUser,
    dto: PutPayrollPfConfigDto,
  ): Promise<PayrollPfConfigView> {
    const tenantId = requireTenant(user);
    const admin = this.supabaseFactory.createAdmin();

    const { data: existing, error: existingError } = await admin
      .from('payroll_pf_config')
      .select(PF_CONFIG_COLUMNS)
      .eq('tenant_id', tenantId)
      .eq('effective_from', dto.effectiveFrom)
      .maybeSingle<PfConfigRow>();
    if (existingError) {
      this.logger.error('Failed to read the existing PF revision:', {
        error: existingError,
      });
      throw internalError('Failed to save the PF config');
    }
    if (existing && existing.covered === dto.covered) {
      return {
        effectiveFrom: existing.effective_from,
        covered: existing.covered,
        updatedAt: existing.updated_at,
      };
    }

    const { data: row, error } = await admin
      .from('payroll_pf_config')
      .upsert(
        {
          tenant_id: tenantId,
          effective_from: dto.effectiveFrom,
          covered: dto.covered,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'tenant_id,effective_from' },
      )
      .select(PF_CONFIG_COLUMNS)
      .single<PfConfigRow>();
    if (error) {
      this.logger.error('Failed to save the PF config:', { error });
      throw internalError('Failed to save the PF config');
    }

    await writeAuditRow(admin, this.logger, 'PF config', {
      actorId: user.userId,
      tenantId,
      action: 'payroll.pf_config_saved',
      targetUser: null,
      details: {
        effective_from: dto.effectiveFrom,
        covered: dto.covered,
        ...(existing ? { previous: { covered: existing.covered } } : {}),
      },
    });
    return {
      effectiveFrom: row.effective_from,
      covered: row.covered,
      updatedAt: row.updated_at,
    };
  }
}

/** The stored switch rows as the resolver reads them. */
export interface PfCoveredRow {
  effectiveFrom: string;
  covered: boolean;
}

/**
 * Whether the switch covers a run month: month-start resolution over the
 * dated rows; no governing row means not covered. An ever-member bypasses
 * this entirely (employeePfCovered).
 */
export function resolvePfCovered(rows: PfCoveredRow[], month: string): boolean {
  // A malformed month would lexically resolve the wrong row — refuse
  // loudly, the same contract pfWageCeiling keeps.
  if (!isMonthKey(month)) {
    throw new Error('resolvePfCovered needs a real month written as YYYY-MM');
  }
  return resolveEffective(rows, month)?.covered ?? false;
}

/**
 * The covered decision for one employee in one run month (CAP-6): an
 * ever-member — anyone with a populated UAN or PF account number — is
 * covered regardless of the switch and regardless of when it turned on;
 * everyone else follows the switch unless the admin excluded them
 * (exclusion is only meaningful for never-members — the save refuses it
 * for ever-members).
 */
export function employeePfCovered(inputs: {
  everMember: boolean;
  switchCovered: boolean;
  excluded: boolean;
}): boolean {
  if (inputs.everMember) return true;
  return inputs.switchCovered && !inputs.excluded;
}
