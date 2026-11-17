import { Injectable, Logger } from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { internalError, requireTenant, writeAuditRow } from './payroll.helpers';
import { PayrollStateRulesView } from './dto/payroll-calendar.dto';

interface StateRulesRow {
  tenant_id: string;
  notified: boolean;
  updated_at: string;
}

/**
 * The per-state overlay flag (SPEC legal constraint): whether the company's
 * state has notified its Code on Wages state rules. The product ships the
 * central Form V template regardless — the flag only tells the web UI and
 * payslip copy whether a state-rules caveat applies. An absent row reads as
 * false. Zero database functions.
 */
@Injectable()
export class PayrollStateRulesService {
  private readonly logger = new Logger(PayrollStateRulesService.name);

  constructor(private readonly supabaseFactory: SupabaseClientFactory) {}

  async read(user: RequestUser): Promise<PayrollStateRulesView> {
    const tenantId = requireTenant(user);
    const { data, error } = await this.supabaseFactory
      .createAdmin()
      .from('payroll_state_rules')
      .select('tenant_id, notified, updated_at')
      .eq('tenant_id', tenantId)
      .maybeSingle<StateRulesRow>();
    if (error) {
      this.logger.error('Failed to read the state rules flag:', { error });
      throw internalError('Failed to load the state rules flag');
    }
    return {
      notified: data?.notified ?? false,
      updatedAt: data?.updated_at ?? new Date(0).toISOString(),
    };
  }

  async save(
    user: RequestUser,
    notified: boolean,
  ): Promise<PayrollStateRulesView> {
    const tenantId = requireTenant(user);
    const admin = this.supabaseFactory.createAdmin();

    // The existence probe decides no-op vs write; a failed probe must not
    // silently turn an identical re-save into a write (phantom audit trail).
    const { data: existing, error: existingError } = await admin
      .from('payroll_state_rules')
      .select('tenant_id, notified, updated_at')
      .eq('tenant_id', tenantId)
      .maybeSingle<StateRulesRow>();
    if (existingError) {
      this.logger.error('Failed to read the state rules flag:', {
        error: existingError,
      });
      throw internalError('Failed to save the state rules flag');
    }
    if (existing && existing.notified === notified) {
      return { notified: existing.notified, updatedAt: existing.updated_at };
    }
    // "false" IS the absent row's answer — storing and auditing it would
    // record a change that never changed anything.
    if (!existing && !notified) {
      return { notified: false, updatedAt: new Date(0).toISOString() };
    }

    const { data: row, error } = await admin
      .from('payroll_state_rules')
      .upsert(
        { tenant_id: tenantId, notified, updated_at: new Date().toISOString() },
        { onConflict: 'tenant_id' },
      )
      .select('tenant_id, notified, updated_at')
      .single<StateRulesRow>();
    if (error) {
      this.logger.error('Failed to save the state rules flag:', { error });
      throw internalError('Failed to save the state rules flag');
    }

    await writeAuditRow(admin, this.logger, 'state-rules', {
      actorId: user.userId,
      tenantId,
      action: 'payroll.state_rules_updated',
      targetUser: null,
      details: { notified },
    });
    return { notified: row.notified, updatedAt: row.updated_at };
  }
}
