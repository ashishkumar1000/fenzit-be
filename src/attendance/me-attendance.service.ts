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
import {
  closedRecordView,
  openRecordView,
  pickTodayFacts,
} from './me-summary-today.model';

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
   *
   * 16-4 adds the Today extension (active only): office pin, today's day
   * facts and today's record — the inputs the pre-flight dialog and the
   * CheckInOutButton need WITHOUT a client-side date/weekday derivation
   * (AD-7/AD-22). Every fact is built by me-summary-today.model over the
   * same picked rule/weekly-off set already shown, so the extension can
   * never disagree with the rest of the summary.
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

    const [rules, overrides, defaults, officePin, holidayName, record, timezone] =
      await Promise.all([
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
        row.office_id
          ? this.readOfficePin(admin, row.tenant_id, row.office_id)
          : Promise.resolve(null),
        this.readHolidayName(admin, row.tenant_id, anchor),
        this.readTodayRecord(admin, row.tenant_id, row.user_id, anchor),
        this.readTimezone(admin, row.tenant_id),
      ]);

    const rule = pickRuleForDate(rules, anchor);
    const weeklyOffDays = pickWeeklyOffDays(overrides, defaults, anchor);

    // The Today extension exists only for `active` — the upcoming anchor
    // is a future date, so "today's facts" would be a lie there.
    const isActive = row.access_state === 'active';
    const today = isActive
      ? pickTodayFacts(weeklyOffDays, holidayName, anchor)
      : null;
    let todayRecord: MeSummaryResponse['todayRecord'] = null;
    if (isActive && record) {
      todayRecord =
        record.checkout_at !== null
          ? closedRecordView(
              record as typeof record & { checkout_at: Date | string },
              timezone,
              rule,
            )
          : openRecordView(record, timezone, rule);
    }

    return toMeSummaryResponse({
      row,
      rule,
      weeklyOffDays,
      officePin,
      today,
      todayRecord,
    });
  }

  /** The office pin (display-only distance hint input). */
  private async readOfficePin(
    admin: ReturnType<SupabaseClientFactory['createAdmin']>,
    tenantId: string,
    officeId: string,
  ): Promise<{ latitude: number; longitude: number } | null> {
    const { data, error } = await admin
      .from('attendance_offices')
      .select('latitude, longitude')
      .eq('tenant_id', tenantId)
      .eq('id', officeId)
      .maybeSingle<{ latitude: number; longitude: number }>();
    if (error) {
      this.logger.error('Failed to read office pin:', { error });
      throw internalError('Failed to read attendance summary');
    }
    return data ?? null;
  }

  /** Today's holiday name (null when today is not a holiday). */
  private async readHolidayName(
    admin: ReturnType<SupabaseClientFactory['createAdmin']>,
    tenantId: string,
    anchor: string,
  ): Promise<string | null> {
    const { data, error } = await admin
      .from('holidays')
      .select('name')
      .eq('tenant_id', tenantId)
      .eq('holiday_date', anchor)
      .maybeSingle<{ name: string }>();
    if (error) {
      this.logger.error('Failed to read holiday:', { error });
      throw internalError('Failed to read attendance summary');
    }
    return data?.name ?? null;
  }

  /** Today's attendance record (null when none yet). */
  private async readTodayRecord(
    admin: ReturnType<SupabaseClientFactory['createAdmin']>,
    tenantId: string,
    employeeId: string,
    anchor: string,
  ): Promise<{
    work_date: string;
    checkin_at: Date | string;
    checkout_at: Date | string | null;
  } | null> {
    const { data, error } = await admin
      .from('attendance_records')
      .select('work_date, checkin_at, checkout_at')
      .eq('tenant_id', tenantId)
      .eq('employee_id', employeeId)
      .eq('work_date', anchor)
      .maybeSingle<{
        work_date: string;
        checkin_at: Date | string;
        checkout_at: Date | string | null;
      }>();
    if (error) {
      this.logger.error('Failed to read today record:', { error });
      throw internalError('Failed to read attendance summary');
    }
    return data ?? null;
  }

  /** The tenant IANA timezone (AD-7's single clock). */
  private async readTimezone(
    admin: ReturnType<SupabaseClientFactory['createAdmin']>,
    tenantId: string,
  ): Promise<string> {
    const { data, error } = await admin
      .from('tenants')
      .select('timezone')
      .eq('id', tenantId)
      .maybeSingle<{ timezone: string }>();
    if (error || !data?.timezone) {
      this.logger.error('Failed to read tenant timezone:', { error });
      throw internalError('Failed to read attendance summary');
    }
    return data.timezone;
  }

  private async readRules(
    admin: ReturnType<SupabaseClientFactory['createAdmin']>,
    tenantId: string,
    officeId: string,
  ): Promise<OfficeRuleRow[]> {
    const { data, error } = await admin
      .from('attendance_office_rules')
      .select('id, valid, start_time, end_time, late_cutoff_minutes, full_day_hours, half_day_hours')
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
