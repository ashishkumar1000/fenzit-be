import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { ErrorCode } from '../common/enums/error-code.enum';
import { isMonthKey } from './effective-dating';
import { moneyText } from './formula';
import {
  internalError,
  requireTenant,
  validationError,
  writeAuditRow,
} from './payroll.helpers';
import {
  PayrollRunOverrideView,
  PutPayrollRunOverrideDto,
} from './dto/payroll-run.dto';

interface MembershipProbe {
  id: string;
}

interface OverrideRow {
  month: string;
  field: string;
  amount: string;
  updated_at: string;
}

/**
 * The per-employee, per-period run override (CAP-6): the admin replaces a
 * computed amount behind an employer-liability acknowledgment. The override
 * survives unlocked re-runs of its period and is immutable after lock (the
 * lock story refuses edits once month 9 ships the lock state). Zero database
 * functions.
 */
@Injectable()
export class PayrollRunOverrideService {
  private readonly logger = new Logger(PayrollRunOverrideService.name);

  constructor(private readonly supabaseFactory: SupabaseClientFactory) {}

  private readonly FIELDS = ['pf_employee', 'tds'] as const;

  async save(
    user: RequestUser,
    targetUserId: string,
    dto: PutPayrollRunOverrideDto,
  ): Promise<PayrollRunOverrideView> {
    const tenantId = requireTenant(user);
    if (!isMonthKey(dto.month)) {
      throw validationError('month must be a real month written as YYYY-MM');
    }
    if (!(this.FIELDS as readonly string[]).includes(dto.field)) {
      throw validationError('field must be pf_employee or tds');
    }
    if (dto.acknowledgedLiability !== true) {
      throw validationError(
        'an override needs the employer-liability acknowledgment — the run pays this amount and the employer carries the statutory exposure',
      );
    }
    const admin = this.supabaseFactory.createAdmin();

    const { data: membership, error: memberError } = await admin
      .from('memberships')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('user_id', targetUserId)
      .maybeSingle<MembershipProbe>();
    if (memberError) {
      this.logger.error('Failed to read the membership for the override:', {
        error: memberError,
      });
      throw internalError('Failed to save the run override');
    }
    if (!membership) {
      throw new NotFoundException({
        error_code: ErrorCode.RESOURCE_NOT_FOUND,
        message: 'No member with that id in your company',
      });
    }

    const amount = moneyText(Number(dto.amount));
    const { data: row, error } = await admin
      .from('payroll_run_overrides')
      .upsert(
        {
          tenant_id: tenantId,
          membership_id: membership.id,
          month: dto.month,
          field: dto.field,
          amount,
          acknowledged: true,
          created_by: user.userId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'tenant_id,membership_id,month,field' },
      )
      .select('month, field, amount, updated_at')
      .single<OverrideRow>();
    if (error) {
      this.logger.error('Failed to save the run override:', { error });
      throw internalError('Failed to save the run override');
    }

    await writeAuditRow(admin, this.logger, 'run override', {
      actorId: user.userId,
      tenantId,
      action: 'payroll.run_override_set',
      targetUser: targetUserId,
      details: { month: dto.month, field: dto.field, amount },
    });
    return {
      month: row.month,
      field: row.field,
      // numeric(18,2) comes back as a JS number — the view is money text.
      amount: moneyText(Number(row.amount)),
      updatedAt: row.updated_at,
    };
  }
}
