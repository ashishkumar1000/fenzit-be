import { Injectable, Logger } from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { internalError, requireTenant } from './payroll.helpers';
import { AuditEntryView } from './dto/payroll-lock.dto';

interface AuditRow {
  id: string;
  created_at: string;
  actor_user_id: string;
  action: string;
  target_user_id: string | null;
  details: Record<string, unknown> | null;
}

/**
 * The payroll audit trail (CAP-11) — the READ surface over the generic
 * `audit_log`. Every payroll mutation has written a `payroll.*` action there
 * through the shared writeAuditRow helper since 23-3 (components, structures,
 * heads, calendar, state rules, PF config/exclusions, run overrides, runs,
 * locks), so no domain table duplicates the trail. Newest first, capped at
 * 100; the (tenant_id, created_at desc) index serves the order. Zero database
 * functions.
 */
@Injectable()
export class PayrollAuditService {
  private readonly logger = new Logger(PayrollAuditService.name);

  constructor(private readonly supabaseFactory: SupabaseClientFactory) {}

  async list(user: RequestUser): Promise<AuditEntryView[]> {
    const tenantId = requireTenant(user);
    const { data, error } = await this.supabaseFactory
      .createAdmin()
      .from('audit_log')
      .select('id, created_at, actor_user_id, action, target_user_id, details')
      .eq('tenant_id', tenantId)
      .like('action', 'payroll.%')
      .order('created_at', { ascending: false })
      // The monotonic tiebreaker the plan names: equal timestamps keep a
      // deterministic order (uuids sort randomly, so this is not recency —
      // it is stability).
      .order('id', { ascending: false })
      .limit(100);
    if (error) {
      this.logger.error('Failed to read the payroll audit trail:', { error });
      throw internalError('Failed to load the payroll audit trail');
    }
    return ((data ?? []) as unknown as AuditRow[]).map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      actorId: row.actor_user_id,
      action: row.action,
      targetUserId: row.target_user_id,
      details:
        row.details &&
        typeof row.details === 'object' &&
        !Array.isArray(row.details)
          ? row.details
          : {},
    }));
  }
}
