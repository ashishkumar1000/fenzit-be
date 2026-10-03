import { BadRequestException } from '@nestjs/common';
import { ErrorCode } from '../../common/enums/error-code.enum';
import {
  ReportDefinition,
  ReportParams,
  RawReportParams,
} from './report-definition';
import { validateReportDateRange } from './report-params.util';
import { fetchTechnicianJobActivityData } from './technician-job-activity.data';
import { buildTechnicianJobActivityDocument } from './technician-job-activity.template';

/** Stable registry id — the value fenzo-app sends as `reportType`. */
export const TECHNICIAN_JOB_ACTIVITY_TYPE = 'technician_job_activity';

/**
 * First report (PRD §4): per-technician job activity over a date range.
 * Complete definition as of story 12-5 — params validation (create-time),
 * tenant-scoped fetcher (IST day bounds, joins, attachment counts, jobs
 * cap), PRD §4 metrics, and the template composed from the brand kit.
 */
export const technicianJobActivityDefinition: ReportDefinition = {
  type: TECHNICIAN_JOB_ACTIVITY_TYPE,
  label: 'Technician Job Report',

  validateParams(raw: RawReportParams): ReportParams {
    // Strict shape: this report scopes by people only — an officeIds value
    // is a client bug (the FE never sends it here), not a silent no-op.
    if (raw.officeIds != null && raw.officeIds.length > 0) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'officeIds is not a valid filter for this report',
      });
    }
    const { startDate, endDate } = validateReportDateRange(
      raw.startDate,
      raw.endDate,
    );
    return {
      start_date: startDate,
      end_date: endDate,
      // Pass-through: the service validates the ids against the tenant's
      // technicians (DB check) and normalizes them before insert.
      technician_ids: raw.technicianIds ?? [],
      office_ids: [],
    };
  },

  fetchData: fetchTechnicianJobActivityData,
  buildDocument: buildTechnicianJobActivityDocument,
};
