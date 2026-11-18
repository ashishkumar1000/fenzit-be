import { BadRequestException } from '@nestjs/common';
import { ErrorCode } from '../../common/enums/error-code.enum';
import type { PayslipLeaveBalance } from '../../attendance/dto/leave-balance.dto';
import {
  isPayslipParams,
  type ReportFetchContext,
  type ReportVerifyContext,
} from './report-definition';

/**
 * Payslip report data (23-8) — ONE snapshot row read tenant-scoped by
 * payslipId. The PDF renders from nothing else: a destroyed or replaced row
 * (a re-run of an unlocked month) must fail the request, never deliver a
 * superseded slip. `slip_number` and `run_id` ride along for the pre-upload
 * supersession guard.
 */
export interface PayslipSnapshot {
  id: string;
  run_id: string;
  membership_id: string;
  salary_period: string;
  slip_number: string;
  employee_name: string | null;
  employee_code: string | null;
  father_name: string | null;
  mother_name: string | null;
  spouse_name: string | null;
  designation: string | null;
  department: string | null;
  pan: string | null;
  uan_number: string | null;
  bank_account_number: string | null;
  ifsc_code: string | null;
  bank_name: string | null;
  date_of_joining: string | null;
  establishment_name: string | null;
  establishment_address: string | null;
  wage_period_start: string | null;
  wage_period_end: string | null;
  divisor_convention: string | null;
  cutoff_day: number | null;
  pay_date: number | null;
  payable_days: number;
  lop_days: number;
  paid_days: number;
  days_worked: number | null;
  gross_earnings: number;
  pf_employee: number;
  pf_employer: number;
  tds: number;
  other_deductions: number;
  total_deductions: number;
  net_wages: number;
  earning_lines: Array<{ name: string; amount: number }>;
  deduction_lines: Array<{ source: string; amount: number }>;
  /** 23-13: captured as of the pay-period's last day, enabled accrual
   *  types only — the PDF renders the section only when it is non-empty. */
  leave_balances: PayslipLeaveBalance[];
}

const SNAPSHOT_COLUMNS = [
  'id',
  'run_id',
  'membership_id',
  'salary_period',
  'slip_number',
  'employee_name',
  'employee_code',
  'father_name',
  'mother_name',
  'spouse_name',
  'designation',
  'department',
  'pan',
  'uan_number',
  'bank_account_number',
  'ifsc_code',
  'bank_name',
  'date_of_joining',
  'establishment_name',
  'establishment_address',
  'wage_period_start',
  'wage_period_end',
  'divisor_convention',
  'cutoff_day',
  'pay_date',
  'payable_days',
  'lop_days',
  'paid_days',
  'days_worked',
  'gross_earnings',
  'pf_employee',
  'pf_employer',
  'tds',
  'other_deductions',
  'total_deductions',
  'net_wages',
  'earning_lines',
  'deduction_lines',
  'leave_balances',
].join(', ');

/** The pipeline maps this code straight onto the request row — a clean
 *  `failed` whose error says WHY it failed (superseded, missing, read
 *  error), never a bare generation failure. */
function generationFailed(message: string): BadRequestException {
  return new BadRequestException({
    error_code: ErrorCode.REPORT_GENERATION_FAILED,
    message,
  });
}

/** The worker-path fetch: tenant-scoped by payslipId (the params triple's
 *  month/membershipId are cross-checked against the row — defense in depth
 *  over a stale or forged request). */
export async function fetchPayslipReportData(
  ctx: ReportFetchContext,
): Promise<PayslipSnapshot> {
  if (!isPayslipParams(ctx.params)) {
    throw generationFailed('This request does not point at a payslip');
  }
  const { data, error } = await ctx.supabase
    .from('payroll_payslips')
    .select(SNAPSHOT_COLUMNS)
    .eq('tenant_id', ctx.tenantId)
    .eq('id', ctx.params.payslipId)
    .eq('salary_period', ctx.params.month)
    .eq('membership_id', ctx.params.membershipId)
    .maybeSingle<PayslipSnapshot>();
  if (error) {
    throw generationFailed('Failed to read the payslip snapshot');
  }
  if (!data) {
    // The row was destroyed (a re-run replaced it) or never existed — the
    // request fails cleanly and can be re-issued against the live row.
    throw generationFailed(
      'This payslip no longer exists — request the PDF again from the latest payroll run',
    );
  }
  return data;
}

/**
 * The supersession guard (23-8): after fetch, BEFORE the render and any
 * upload or ready stamp, re-read the SAME row tenant-scoped and demand the
 * same slip_number AND run_id. A re-run that destroyed and replaced the
 * payslip mid-generation flips the request to a clean `failed` instead of
 * delivering the superseded slip. Best-effort by design — a destroy landing
 * inside the verify→stamp window can still race the stamp; the destroy runs
 * in the re-run's transaction while the window is a render+upload of
 * milliseconds, and a mismatch at fetch time catches the same re-run
 * ordered the other way.
 */
export async function verifyPayslipSnapshot(
  ctx: ReportVerifyContext,
): Promise<void> {
  if (!isPayslipParams(ctx.params)) {
    throw generationFailed('This request does not point at a payslip');
  }
  const fetched = ctx.data as PayslipSnapshot | null;
  if (!fetched || typeof fetched.slip_number !== 'string') {
    throw generationFailed('The fetched payslip snapshot is incomplete');
  }
  const { data, error } = await ctx.supabase
    .from('payroll_payslips')
    .select('slip_number, run_id')
    .eq('tenant_id', ctx.tenantId)
    .eq('id', ctx.params.payslipId)
    .maybeSingle<{ slip_number: string; run_id: string }>();
  if (error) {
    throw generationFailed('Failed to re-verify the payslip snapshot');
  }
  if (
    !data ||
    data.slip_number !== fetched.slip_number ||
    data.run_id !== fetched.run_id
  ) {
    throw generationFailed(
      'This payslip was replaced by a newer payroll run while the PDF was being generated — request it again',
    );
  }
}
