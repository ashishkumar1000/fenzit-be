import { ReportRequestStatus } from '../../reports/enums/report-status.enum';
import type { PayslipLeaveBalance } from '../../attendance/dto/leave-balance.dto';

/**
 * A `payroll_payslips` row as PostgREST returns it — the Form V + product
 * snapshot (CAP-7). The PDF renders straight from this row; the API never
 * recomputes any amount.
 */
export interface PayslipRow {
  id: string;
  tenant_id: string;
  membership_id: string;
  user_id: string;
  run_id: string;
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
  /** Present days with half_day as 0.5 — Form V's "days worked". */
  days_worked: number | null;
  gross_earnings: number;
  pf_employee: number;
  pf_employer: number;
  tds: number;
  other_deductions: number;
  total_deductions: number;
  net_wages: number;
  /** [{ name, amount }] — the printed break-up sums to gross_earnings. */
  earning_lines: Array<{ name: string; amount: number }>;
  /** [{ source, amount }] — source: pf_employee | tds | head:<name> | recovery:<month>. */
  deduction_lines: Array<{ source: string; amount: number }>;
  /** [{ code, name, accrued, availed, carryForward, remaining }] — captured
   *  as of the pay-period's last day (23-13), enabled accrual types only. */
  leave_balances: PayslipLeaveBalance[];
  warnings: string[];
  created_at: string;
}

/** The PDF-request state joined onto a payslip (none = no request yet). */
export type PayslipPdfStatus =
  'none' | 'queued' | 'running' | 'ready' | 'failed';

export interface PayslipPdf {
  status: PayslipPdfStatus;
  /** Presigned download URL — present only when ready AND presigning succeeded. */
  url?: string;
}

/** The payslip snapshot as the API answers it (camelCase over the row). */
export interface PayslipView {
  id: string;
  membershipId: string;
  runId: string;
  month: string;
  slipNumber: string;
  employeeName: string | null;
  employeeCode: string | null;
  fatherName: string | null;
  motherName: string | null;
  spouseName: string | null;
  designation: string | null;
  department: string | null;
  pan: string | null;
  uanNumber: string | null;
  bankAccountNumber: string | null;
  ifscCode: string | null;
  bankName: string | null;
  dateOfJoining: string | null;
  establishmentName: string | null;
  establishmentAddress: string | null;
  wagePeriodStart: string | null;
  wagePeriodEnd: string | null;
  divisorConvention: string | null;
  cutoffDay: number | null;
  payDate: number | null;
  payableDays: number;
  lopDays: number;
  paidDays: number;
  daysWorked: number | null;
  grossEarnings: number;
  pfEmployee: number;
  pfEmployer: number;
  tds: number;
  otherDeductions: number;
  totalDeductions: number;
  netWages: number;
  earningLines: Array<{ name: string; amount: number }>;
  deductionLines: Array<{ source: string; amount: number }>;
  leaveBalances: PayslipLeaveBalance[];
  warnings: string[];
  createdAt: string;
  pdf: PayslipPdf;
}

/** The response of both PDF-request POSTs (mirrors CreateReportResponse). */
export interface PayslipPdfRequestView {
  id: string;
  status: ReportRequestStatus;
  createdAt: string;
}
