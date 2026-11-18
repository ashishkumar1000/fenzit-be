import { payslipReportDefinition, PAYSLIP_REPORT_TYPE } from './payslip.definition';
import {
  fetchPayslipReportData,
  verifyPayslipSnapshot,
} from './payslip.data';
import { buildPayslipDocument } from './payslip.template';
import { BadRequestException } from '@nestjs/common';
import { ErrorCode } from '../../common/enums/error-code.enum';

/**
 * The payslip definition's param contract (23-8): validateParams is PURE —
 * shape only, no DB access — and the generic POST /reports route can never
 * forge a payslip request through it (its body carries none of the triple,
 * so the missing-month refusal fires first).
 */

const UUID = '00000000-0000-4000-8000-0000000000a1';

const invalidMessage = (e: unknown): string =>
  (e as BadRequestException).getResponse()['message'];

describe('payslipReportDefinition.validateParams (23-8)', () => {
  it('refuses a body without month — the generic /reports route cannot forge a payslip', () => {
    try {
      payslipReportDefinition.validateParams({});
      throw new Error('expected a throw');
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestException);
      expect((e as BadRequestException).getResponse()).toMatchObject({
        error_code: ErrorCode.VALIDATION_ERROR,
      });
      expect(invalidMessage(e)).toBe(
        'Payslip PDFs are requested from the payroll payslip endpoints',
      );
    }
  });

  it('refuses a non-month or impossible month', () => {
    for (const month of ['2026-13', '2026-1', 'october', '2026-00']) {
      try {
        payslipReportDefinition.validateParams({ month });
        throw new Error(`expected a throw for ${month}`);
      } catch (e) {
        expect(invalidMessage(e)).toBe(
          'month must be a real month written as YYYY-MM',
        );
      }
    }
  });

  it('refuses a NON-STRING month (a number coerces to "" and fails the same shape check)', () => {
    try {
      payslipReportDefinition.validateParams({ month: 202610 } as never);
      throw new Error('expected a throw');
    } catch (e) {
      expect(invalidMessage(e)).toBe(
        'month must be a real month written as YYYY-MM',
      );
    }
  });

  it('refuses non-uuid membership and payslip ids', () => {
    try {
      payslipReportDefinition.validateParams({
        month: '2026-10',
        membershipId: 'not-a-uuid',
        payslipId: UUID,
      });
      throw new Error('expected a throw');
    } catch (e) {
      expect(invalidMessage(e)).toBe('membershipId must be a valid employee id');
    }

    try {
      payslipReportDefinition.validateParams({
        month: '2026-10',
        membershipId: UUID,
        payslipId: 'not-a-uuid',
      });
      throw new Error('expected a throw');
    } catch (e) {
      expect(invalidMessage(e)).toBe('payslipId must be a valid payslip id');
    }
  });

  it('accepts the full triple and stores it verbatim', () => {
    expect(
      payslipReportDefinition.validateParams({
        month: '2026-10',
        membershipId: UUID,
        payslipId: UUID,
      }),
    ).toEqual({ month: '2026-10', membershipId: UUID, payslipId: UUID });
  });

  it('registers under the stable payslip type with the full engine contract', () => {
    expect(PAYSLIP_REPORT_TYPE).toBe('payslip');
    expect(payslipReportDefinition.type).toBe('payslip');
    expect(payslipReportDefinition.fetchData).toBe(fetchPayslipReportData);
    expect(payslipReportDefinition.buildDocument).toBe(buildPayslipDocument);
    // The supersession gate is wired — the "never delivered" guarantee.
    expect(payslipReportDefinition.verifyBeforeReady).toBe(
      verifyPayslipSnapshot,
    );
  });
});
