import { Injectable, Logger } from '@nestjs/common';
import { SupabaseClientFactory } from '../factories/supabase-client.factory';
import { MembershipRole } from '../enums/role.enum';

/** What the database says about a person right now. */
export interface ResolvedAccess {
  userId: string;
  platformAdmin: boolean;
  disabled: boolean;
  /** The person's ACTIVE membership, or null (new, invited, or removed). */
  membership: { tenantId: string; role: MembershipRole } | null;
}

interface UserAccessRow {
  id: string;
  platform_admin: boolean;
  disabled: boolean;
  memberships: Array<{ tenant_id: string; role: string; status: string }> | null;
}

/**
 * Reads a person's access from the database on every request (decision 6):
 * the login token carries identity only, so a removed or disabled person
 * loses access on their next request. A separate class so tests can replace
 * it without mocking the database client.
 */
@Injectable()
export class MembershipResolver {
  private readonly logger = new Logger(MembershipResolver.name);

  constructor(private readonly supabaseFactory: SupabaseClientFactory) {}

  /** Null when no such user exists. Throws on a database failure. */
  async resolve(userId: string): Promise<ResolvedAccess | null> {
    const { data, error } = await this.supabaseFactory
      .createAdmin()
      .from('users')
      // memberships has two keys to users (user_id, invited_by): name the one.
      .select(
        'id, platform_admin, disabled, memberships:memberships!memberships_user_id_fkey(tenant_id, role, status)',
      )
      .eq('id', userId)
      .maybeSingle<UserAccessRow>();

    if (error) {
      this.logger.error('Failed to read access for the request:', error);
      throw error;
    }
    if (!data) {
      return null;
    }

    const active = (data.memberships ?? []).find((m) => m.status === 'active');
    return {
      userId: data.id,
      platformAdmin: data.platform_admin,
      disabled: data.disabled,
      membership: active
        ? { tenantId: active.tenant_id, role: active.role as MembershipRole }
        : null,
    };
  }

  /** Does this company exist? Used to validate a platform admin's X-Company-Id. */
  async companyExists(tenantId: string): Promise<boolean> {
    const { data, error } = await this.supabaseFactory
      .createAdmin()
      .from('tenants')
      .select('id')
      .eq('id', tenantId)
      .maybeSingle();
    if (error) {
      this.logger.error('Failed to check the company for the request:', error);
      throw error;
    }
    return data !== null;
  }
}
