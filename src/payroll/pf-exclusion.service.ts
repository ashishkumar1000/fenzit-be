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
import {
  PayrollPfExclusionView,
  PutPayrollPfExclusionDto,
} from './dto/payroll-deductions.dto';

interface MembershipProbe {
  id: string;
  uan_number: string | null;
  pf_account_number: string | null;
}

interface ExclusionRow {
  excluded: boolean;
  updated_at: string;
}

/**
 * The per-employee PF exclusion (CAP-6): enrollment is the default (the
 * Sivasankaran line — post-first-coverage joiners above the ceiling cannot
 * claim exclusion), so exclusion is an admin configuration with an
 * EPFO-flux warning. It can only ever apply to a NEVER-member: an employee
 * carrying a UAN or PF account number is refused — anyone ever an EPF
 * member is covered at any wage. Saving false when no row exists stores
 * nothing (false is what absence already means). Zero database functions.
 */
@Injectable()
export class PayrollPfExclusionService {
  private readonly logger = new Logger(PayrollPfExclusionService.name);

  constructor(private readonly supabaseFactory: SupabaseClientFactory) {}

  /** The membership row must exist in the caller's company. */
  private async probeMembership(
    admin: ReturnType<SupabaseClientFactory['createAdmin']>,
    tenantId: string,
    targetUserId: string,
  ): Promise<MembershipProbe> {
    const { data, error } = await admin
      .from('memberships')
      .select('id, uan_number, pf_account_number')
      .eq('tenant_id', tenantId)
      .eq('user_id', targetUserId)
      .maybeSingle<MembershipProbe>();
    if (error) {
      this.logger.error('Failed to read the membership for PF exclusion:', {
        error,
      });
      throw internalError('Failed to load the PF exclusion');
    }
    if (!data) {
      throw new NotFoundException({
        error_code: ErrorCode.RESOURCE_NOT_FOUND,
        message: 'No member with that id in your company',
      });
    }
    return data;
  }

  async read(
    user: RequestUser,
    targetUserId: string,
  ): Promise<PayrollPfExclusionView> {
    const tenantId = requireTenant(user);
    const admin = this.supabaseFactory.createAdmin();
    const membership = await this.probeMembership(
      admin,
      tenantId,
      targetUserId,
    );

    const { data: row, error } = await admin
      .from('payroll_pf_exclusions')
      .select('excluded, updated_at')
      .eq('tenant_id', tenantId)
      .eq('membership_id', membership.id)
      .maybeSingle<ExclusionRow>();
    if (error) {
      this.logger.error('Failed to read the PF exclusion:', { error });
      throw internalError('Failed to load the PF exclusion');
    }
    return {
      excluded: row?.excluded ?? false,
      updatedAt: row?.updated_at ?? new Date(0).toISOString(),
    };
  }

  async save(
    user: RequestUser,
    targetUserId: string,
    dto: PutPayrollPfExclusionDto,
  ): Promise<PayrollPfExclusionView> {
    const tenantId = requireTenant(user);
    const admin = this.supabaseFactory.createAdmin();
    const membership = await this.probeMembership(
      admin,
      tenantId,
      targetUserId,
    );

    // The never-member rule: an ever-member is covered at any wage.
    if (
      dto.excluded &&
      (membership.uan_number || membership.pf_account_number)
    ) {
      throw validationError(
        'this employee carries a UAN or PF account number, so they are covered under EPF regardless of the switch — an exclusion can only apply to someone who was never a member',
      );
    }

    const { data: existing, error: existingError } = await admin
      .from('payroll_pf_exclusions')
      .select('excluded, updated_at')
      .eq('tenant_id', tenantId)
      .eq('membership_id', membership.id)
      .maybeSingle<ExclusionRow>();
    if (existingError) {
      this.logger.error('Failed to read the existing PF exclusion:', {
        error: existingError,
      });
      throw internalError('Failed to save the PF exclusion');
    }
    if (existing && existing.excluded === dto.excluded) {
      return { excluded: existing.excluded, updatedAt: existing.updated_at };
    }
    if (!existing && !dto.excluded) {
      // False is what absence already means — store nothing.
      return { excluded: false, updatedAt: new Date(0).toISOString() };
    }

    const { data: row, error } = await admin
      .from('payroll_pf_exclusions')
      .upsert(
        {
          tenant_id: tenantId,
          membership_id: membership.id,
          excluded: dto.excluded,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'tenant_id,membership_id' },
      )
      .select('excluded, updated_at')
      .single<ExclusionRow>();
    if (error) {
      this.logger.error('Failed to save the PF exclusion:', { error });
      throw internalError('Failed to save the PF exclusion');
    }

    await writeAuditRow(admin, this.logger, 'PF exclusion', {
      actorId: user.userId,
      tenantId,
      action: 'payroll.pf_exclusion_set',
      targetUser: targetUserId,
      details: { excluded: dto.excluded },
    });
    return { excluded: row.excluded, updatedAt: row.updated_at };
  }
}
