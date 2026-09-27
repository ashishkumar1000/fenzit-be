import { Injectable, Logger } from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import {
  AccessStateRow,
  AccessStateResponse,
  toAccessStateResponse,
} from './enrolments-response.model';
import { markOnboarded } from './enrolments.repository';
import { internalError, requireTenant } from './attendance-rpc.helpers';

/**
 * Technician-facing attendance reads (15-7): the AD-17 access state from
 * the view (id from the JWT only) and FR-4's once-per-employee onboarding
 * record.
 */
@Injectable()
export class MeAttendanceService {
  private readonly logger = new Logger(MeAttendanceService.name);

  constructor(private readonly supabaseClientFactory: SupabaseClientFactory) {}

  /** GET /attendance/me/access — the entry-point gate (FR-3). */
  async getAccess(user: RequestUser): Promise<AccessStateResponse> {
    const admin = this.supabaseClientFactory.createAdmin();
    const { data, error } = await admin
      .from('attendance_access_state')
      .select('*')
      .eq('user_id', user.userId)
      .maybeSingle<AccessStateRow>();

    if (error) {
      this.logger.error('Failed to read access state:', { error });
      throw internalError('Failed to read access state');
    }
    // A technician always has a view row (it is user-keyed); absence means
    // the view contract broke — fail loud rather than fabricate a state.
    if (!data) {
      throw internalError('Failed to read access state');
    }
    return toAccessStateResponse(data);
  }

  /** POST /attendance/me/onboarding — first write wins (FR-4). */
  async markOnboarded(
    user: RequestUser,
  ): Promise<{ onboardedAt: string | null }> {
    const tenantId = requireTenant(user);
    const admin = this.supabaseClientFactory.createAdmin();
    return {
      onboardedAt: await markOnboarded(admin, tenantId, user.userId),
    };
  }
}
