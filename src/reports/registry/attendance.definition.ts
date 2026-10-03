import { BadRequestException } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ErrorCode } from '../../common/enums/error-code.enum';
import {
  ReportDefinition,
  ReportParams,
  RawReportParams,
} from './report-definition';
import { validateReportDateRange } from './report-params.util';
import { fetchAttendanceReportData } from './attendance.data';
import { buildAttendanceReportDocument } from './attendance.template';

/**
 * Attendance Report (Epic 21) — the second report type in the registry.
 * One owner-scoped PDF over the tenant's attendance data: overall metrics,
 * office summary, per-employee attendance + discipline + hours, exceptions,
 * weekly trend, leave summary, and the day register for short ranges.
 *
 * Every number derives from the shared day-status engine
 * (`common/day-status/`) — the FR-11 parity contract: the PDF can never
 * disagree with the in-app monthly grid. The fetcher (21-2) reads the grid
 * through `readDayStatusGrid` on the pipeline's transaction client; the
 * template (21-3) composes only brand-kit structure.
 *
 * Scope model (spec-attendance-report):
 *  - `technician_ids` carries the selected EMPLOYEES (the FE labels the
 *    field per report type); empty = all enrolled employees.
 *  - `office_ids` scopes per DAY (an employee may count under different
 *    offices within one range — effective-dated assignments); empty = all
 *    offices.
 *  - Attendance-rate denominator excludes approved leave (owner-confirmed
 *    2026-10-03).
 */

/** Stable registry id — the value fenzo-app sends as `reportType`. */
export const ATTENDANCE_REPORT_TYPE = 'attendance_report';

/**
 * Explicit people cap (21-1): the biggest real tenant runs ~100 enrolled
 * employees, so the job report's 25-technician FR1 cap would reject a
 * legitimate selection. The real scale protection is the employee-day row
 * guard (REPORT_MAX_ATTENDANCE_ROWS) enforced at fetch time.
 */
export const MAX_EMPLOYEES_PER_ATTENDANCE_REPORT = 200;

/** Shape sanity for the office id list — existence is checked per tenant. */
const MAX_OFFICES_PER_REPORT = 50;

function invalid(message: string): BadRequestException {
  return new BadRequestException({
    error_code: ErrorCode.VALIDATION_ERROR,
    message,
  });
}

export const attendanceReportDefinition: ReportDefinition = {
  type: ATTENDANCE_REPORT_TYPE,
  label: 'Attendance Report',
  maxTechnicianIds: MAX_EMPLOYEES_PER_ATTENDANCE_REPORT,

  validateParams(raw: RawReportParams): ReportParams {
    const { startDate, endDate } = validateReportDateRange(
      raw.startDate,
      raw.endDate,
    );
    const officeIds = [...new Set(raw.officeIds ?? [])];
    if (officeIds.length > MAX_OFFICES_PER_REPORT) {
      throw invalid(
        `A report can be scoped to at most ${MAX_OFFICES_PER_REPORT} offices`,
      );
    }
    return {
      start_date: startDate,
      end_date: endDate,
      // Pass-through: the service validates the ids against the tenant's
      // technicians (role check) and this definition's validateAccess
      // verifies enrolment before the request row is inserted.
      technician_ids: raw.technicianIds ?? [],
      office_ids: officeIds,
    };
  },

  async validateAccess(supabase, tenantId, params): Promise<void> {
    // Module gate: the tenant attendance module must be enabled AND set up.
    // The FE hides the type on the same flag (users/me mirror) — this is
    // the defense-in-depth arm.
    const { data: settings, error: settingsError } = await supabase
      .from('attendance_settings')
      .select('enabled, setup_completed_at')
      .eq('tenant_id', tenantId)
      .maybeSingle<{ enabled: boolean; setup_completed_at: string | null }>();
    if (settingsError) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Failed to verify the attendance module',
      });
    }
    if (!settings || !settings.enabled || settings.setup_completed_at == null) {
      throw new BadRequestException({
        error_code: ErrorCode.ATTENDANCE_NOT_ENABLED,
        message: 'Attendance is not enabled for your company',
      });
    }

    // Office membership: every selected office must belong to the tenant.
    // Archived offices are allowed — their history lives in the records.
    if (params.office_ids.length > 0) {
      const { data: offices, error: officesError } = await supabase
        .from('attendance_offices')
        .select('id')
        .eq('tenant_id', tenantId)
        .in('id', params.office_ids);
      if (officesError) {
        throw new BadRequestException({
          error_code: ErrorCode.VALIDATION_ERROR,
          message: 'Failed to verify the selected offices',
        });
      }
      const found = new Set((offices ?? []).map((o) => o.id));
      if (params.office_ids.some((id) => !found.has(id))) {
        throw invalid('officeIds must all be offices of your company');
      }
    }

    // Employee membership: every selected employee must be (or have been)
    // enrolled in attendance — a technician without an enrolment row has
    // no tracked days and would silently render an empty row.
    if (params.technician_ids.length > 0) {
      const { data: enrolments, error: enrolmentsError } = await supabase
        .from('attendance_enrolments')
        .select('employee_id')
        .eq('tenant_id', tenantId)
        .in('employee_id', params.technician_ids);
      if (enrolmentsError) {
        throw new BadRequestException({
          error_code: ErrorCode.VALIDATION_ERROR,
          message: 'Failed to verify the selected employees',
        });
      }
      const enrolled = new Set((enrolments ?? []).map((e) => e.employee_id));
      if (params.technician_ids.some((id) => !enrolled.has(id))) {
        throw invalid(
          'technicianIds must all be employees enrolled in attendance',
        );
      }
    }
  },

  fetchData: fetchAttendanceReportData,
  buildDocument: buildAttendanceReportDocument,
};
