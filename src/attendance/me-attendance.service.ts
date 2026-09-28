import { Injectable, Logger } from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import {
  AccessStateRow,
  AccessStateResponse,
  toAccessStateResponse,
} from './enrolments-response.model';
import { markOnboarded } from './enrolments.repository';
import { internalError, requireTenant, resolveTenantToday } from './attendance-rpc.helpers';
import {
  EMPTY_ME_SUMMARY,
  isSummarisableState,
  MeSummaryResponse,
  pickRuleForDate,
  pickWeeklyOffDays,
  toMeSummaryResponse,
} from './me-summary.model';
import type { OfficeRuleRow, WeeklyOffRow } from './me-summary.model';

/**
 * Technician-facing attendance reads (15-7): the AD-17 access state from
 * the view (id from the JWT only) and FR-4's once-per-employee onboarding
 * record. 15-10 adds the FR-4 summary — office/timings/cut-off/weekly
 * offs, anchored on the SAME view row me/access returns so the two
 * endpoints can never disagree about which office applies.
 */
@Injectable()
export class MeAttendanceService {
  private readonly logger = new Logger(MeAttendanceService.name);

  constructor(private readonly supabaseClientFactory: SupabaseClientFactory) {}

  /** The employee's `attendance_access_state` view row (fail-loud). */
  private async readAccessRow(
    admin: ReturnType<SupabaseClientFactory['createAdmin']>,
    userId: string,
  ): Promise<AccessStateRow> {
    const { data, error } = await admin
      .from('attendance_access_state')
      .select('*')
      .eq('user_id', userId)
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
    return data;
  }

  /** GET /attendance/me/access — the entry-point gate (FR-3). */
  async getAccess(user: RequestUser): Promise<AccessStateResponse> {
    const admin = this.supabaseClientFactory.createAdmin();
    const row = await this.readAccessRow(admin, user.userId);
    return toAccessStateResponse(row);
  }

  /**
   * GET /attendance/me/summary — the FR-4 summary for active/upcoming
   * employees (15-10). officeId and the anchor date come from the SAME
   * view row me/access reads; only the rule and weekly-off selection are
   * new reads. none/history_only answer honestly empty (disable clips
   * both ranges, so no office exists for them).
   */
  async getSummary(user: RequestUser): Promise<MeSummaryResponse> {
    const admin = this.supabaseClientFactory.createAdmin();
    const row = await this.readAccessRow(admin, user.userId);
    if (!isSummarisableState(row.access_state)) {
      return EMPTY_ME_SUMMARY;
    }

    // Upcoming: the view already anchors the office at the next period's
    // start, which IS attendance_start_date. Active: the view anchors at
    // today — resolve the tenant date the same way the view does.
    const anchor =
      row.access_state === 'upcoming' && row.attendance_start_date
        ? row.attendance_start_date
        : await resolveTenantToday(admin, row.tenant_id);

    const [rules, overrides, defaults] = await Promise.all([
      row.office_id
        ? this.readRules(admin, row.tenant_id, row.office_id)
        : Promise.resolve([] as OfficeRuleRow[]),
      this.readWeeklyOffRows(
        admin,
        'attendance_weekly_off_overrides',
        row.tenant_id,
        row.user_id,
      ),
      this.readWeeklyOffRows(admin, 'attendance_weekly_off_defaults', row.tenant_id),
    ]);

    return toMeSummaryResponse({
      row,
      rule: pickRuleForDate(rules, anchor),
      weeklyOffDays: pickWeeklyOffDays(overrides, defaults, anchor),
    });
  }

  private async readRules(
    admin: ReturnType<SupabaseClientFactory['createAdmin']>,
    tenantId: string,
    officeId: string,
  ): Promise<OfficeRuleRow[]> {
    const { data, error } = await admin
      .from('attendance_office_rules')
      .select('id, valid, start_time, end_time, late_cutoff_minutes')
      .eq('tenant_id', tenantId)
      .eq('office_id', officeId)
      .returns<OfficeRuleRow[]>();
    if (error) {
      this.logger.error('Failed to read office rules:', { error });
      throw internalError('Failed to read attendance summary');
    }
    return data ?? [];
  }

  private async readWeeklyOffRows(
    admin: ReturnType<SupabaseClientFactory['createAdmin']>,
    table: 'attendance_weekly_off_defaults' | 'attendance_weekly_off_overrides',
    tenantId: string,
    employeeId?: string,
  ): Promise<WeeklyOffRow[]> {
    let query = admin
      .from(table)
      .select('valid, days')
      .eq('tenant_id', tenantId);
    if (employeeId) {
      query = query.eq('employee_id', employeeId);
    }
    const { data, error } = await query.returns<WeeklyOffRow[]>();
    if (error) {
      this.logger.error(`Failed to read ${table}:`, { error });
      throw internalError('Failed to read attendance summary');
    }
    return data ?? [];
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
