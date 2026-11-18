import { BadRequestException } from '@nestjs/common';
import { ErrorCode } from '../../common/enums/error-code.enum';
import {
  PayslipReportParams,
  ReportDefinition,
  ReportParams,
  RawReportParams,
} from './report-definition';
import { isUuidShape } from './report-params.util';
import { fetchPayslipReportData, verifyPayslipSnapshot } from './payslip.data';
import { buildPayslipDocument } from './payslip.template';

/** Stable registry id — the type the payroll payslip endpoints queue. */
export const PAYSLIP_REPORT_TYPE = 'payslip';

/** A real month, YYYY-MM, 01–12 (the shape the payroll month keys use). */
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function invalid(message: string): BadRequestException {
  return new BadRequestException({
    error_code: ErrorCode.VALIDATION_ERROR,
    message,
  });
}

/**
 * Payslip PDF (23-8, CAP-7): Form V rendered from ONE payroll_payslips
 * snapshot row. The request row's params pin the exact triple
 * {month, membershipId, payslipId}, so a re-run's new payslip (new row id)
 * never inherits the destroyed row's request.
 *
 * validateParams is PURE — shape only, no DB access (the report-definition
 * contract): row-existence and tenant checks live at the payroll-side
 * insert and are re-verified by fetchData on the worker path. The generic
 * POST /reports route can never forge a payslip request — its body has no
 * month/membershipId/payslipId fields, so this shape check refuses it
 * before any row is read.
 */
export const payslipReportDefinition: ReportDefinition = {
  type: PAYSLIP_REPORT_TYPE,
  label: 'Payslip',

  validateParams(raw: RawReportParams): ReportParams {
    if (!('month' in raw)) {
      throw invalid(
        'Payslip PDFs are requested from the payroll payslip endpoints',
      );
    }
    const params = raw as {
      month: unknown;
      membershipId: unknown;
      payslipId: unknown;
    };
    const month = typeof params.month === 'string' ? params.month : '';
    const membershipId =
      typeof params.membershipId === 'string' ? params.membershipId : '';
    const payslipId =
      typeof params.payslipId === 'string' ? params.payslipId : '';
    if (!MONTH_RE.test(month)) {
      throw invalid('month must be a real month written as YYYY-MM');
    }
    if (!isUuidShape(membershipId)) {
      throw invalid('membershipId must be a valid employee id');
    }
    if (!isUuidShape(payslipId)) {
      throw invalid('payslipId must be a valid payslip id');
    }
    return {
      month,
      membershipId,
      payslipId,
    } satisfies PayslipReportParams;
  },

  fetchData: fetchPayslipReportData,
  buildDocument: buildPayslipDocument,
  // The "never delivered" guarantee: the snapshot row is re-verified after
  // fetch and BEFORE the render, any upload, and the ready stamp (23-8
  // review patch — a superseded slip pays no pdfmake CPU and uploads
  // nothing; the residual verify→stamp window is best-effort by design).
  verifyBeforeReady: verifyPayslipSnapshot,
};
