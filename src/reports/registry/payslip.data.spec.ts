import { BadRequestException } from '@nestjs/common';
import { ErrorCode } from '../../common/enums/error-code.enum';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchPayslipReportData, verifyPayslipSnapshot } from './payslip.data';
import type { PayslipSnapshot } from './payslip.data';

/**
 * The supersession gate's OWN branches (23-8, second-pass review): the
 * pipeline tests exercise a mocked gate — these run the real
 * verifyPayslipSnapshot / fetchPayslipReportData against a mocked client.
 * A neutered gate (guard deleted, mismatch comparison removed) must fail
 * HERE, not ship green.
 */

const TENANT = 'tenant-uuid';
const PARAMS = {
  month: '2026-10',
  membershipId: '00000000-0000-4000-8000-0000000000b1',
  payslipId: '00000000-0000-4000-8000-0000000000c1',
};

const snapshot: PayslipSnapshot = {
  id: PARAMS.payslipId,
  run_id: 'run-old',
  membership_id: PARAMS.membershipId,
  salary_period: '2026-10',
  slip_number: 'PS-001',
  employee_name: 'Asha',
  employee_code: null,
  father_name: null,
  mother_name: null,
  spouse_name: null,
  designation: null,
  department: null,
  pan: null,
  uan_number: null,
  bank_account_number: null,
  ifsc_code: null,
  bank_name: null,
  date_of_joining: null,
  establishment_name: null,
  establishment_address: null,
  wage_period_start: null,
  wage_period_end: null,
  divisor_convention: null,
  cutoff_day: null,
  pay_date: 5,
  payable_days: 30,
  lop_days: 0,
  paid_days: 30,
  days_worked: null,
  gross_earnings: 10000,
  pf_employee: 780,
  pf_employer: 780,
  tds: 500,
  other_deductions: 0,
  total_deductions: 1280,
  net_wages: 8720,
  earning_lines: [{ name: 'Basic', amount: 10000 }],
  deduction_lines: [],
} as never;

/** The tenant-scoped re-read: select(cols).eq(tenant).eq(id).maybeSingle(). */
function readChain(result: { data: unknown; error: unknown }) {
  const qb: Record<string, jest.Mock> = {} as never;
  for (const m of ['eq']) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.select = jest.fn().mockReturnValue(qb);
  qb.maybeSingle = jest.fn().mockResolvedValue(result);
  return qb;
}

function fetchCtx(reRead: { data: unknown; error: unknown }) {
  const qb = readChain(reRead);
  const supabase = {
    from: jest.fn(() => qb),
  } as never as SupabaseClient;
  return {
    ctx: {
      supabase,
      tenantId: TENANT,
      requestId: 'req-uuid',
      params: PARAMS,
    },
    qb,
  };
}

const invalidMessage = (e: unknown): string =>
  (e as BadRequestException).getResponse()['message'];

describe('verifyPayslipSnapshot (23-8)', () => {
  it('throws when the re-read finds the row DESTROYED (data null)', async () => {
    const { ctx, qb } = fetchCtx({ data: null, error: null });

    await expect(
      verifyPayslipSnapshot({ ...ctx, data: snapshot }),
    ).rejects.toMatchObject({
      response: {
        error_code: ErrorCode.REPORT_GENERATION_FAILED,
        message: expect.stringContaining('replaced by a newer payroll run'),
      },
    });
    // The re-read is tenant-scoped by payslipId — not by month/membership.
    expect(qb.eq).toHaveBeenCalledWith('tenant_id', TENANT);
    expect(qb.eq).toHaveBeenCalledWith('id', PARAMS.payslipId);
  });

  it('throws when the re-read DISAGREES with the fetched snapshot (run_id mismatch)', async () => {
    const { ctx } = fetchCtx({
      data: { slip_number: 'PS-001', run_id: 'run-NEW' },
      error: null,
    });

    await expect(
      verifyPayslipSnapshot({ ...ctx, data: snapshot }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        error_code: ErrorCode.REPORT_GENERATION_FAILED,
      }),
    });
  });

  it('throws on a slip_number mismatch too', async () => {
    const { ctx } = fetchCtx({
      data: { slip_number: 'PS-002', run_id: 'run-old' },
      error: null,
    });

    await expect(
      verifyPayslipSnapshot({ ...ctx, data: snapshot }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('the SAME row re-read passes the gate silently', async () => {
    const { ctx } = fetchCtx({
      data: { slip_number: 'PS-001', run_id: 'run-old' },
      error: null,
    });

    await expect(
      verifyPayslipSnapshot({ ...ctx, data: snapshot }),
    ).resolves.toBeUndefined();
  });

  it('a re-read FAILURE fails the gate (never stamps ready on a broken read)', async () => {
    const { ctx } = fetchCtx({ data: null, error: { message: 'db down' } });

    await expect(
      verifyPayslipSnapshot({ ...ctx, data: snapshot }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        message: expect.stringContaining('re-verify'),
      }),
    });
  });

  it('an incomplete fetched snapshot is refused before the re-read', async () => {
    const { ctx, qb } = fetchCtx({ data: null, error: null });

    await expect(
      verifyPayslipSnapshot({ ...ctx, data: { slip_number: 42 } }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        message: expect.stringContaining('incomplete'),
      }),
    });
    expect(qb.select).not.toHaveBeenCalled();
  });

  it('non-payslip params are refused', async () => {
    const { ctx } = fetchCtx({ data: null, error: null });

    await expect(
      verifyPayslipSnapshot({ ...ctx, params: {} as never, data: snapshot }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        message: expect.stringContaining('does not point at a payslip'),
      }),
    });
  });
});

describe('fetchPayslipReportData (23-8)', () => {
  it('returns the snapshot row on the tenant-scoped read', async () => {
    const { ctx, qb } = fetchCtx({ data: snapshot, error: null });

    await expect(fetchPayslipReportData(ctx as never)).resolves.toBe(snapshot);
    // All four scope pins ride the fetch itself.
    expect(qb.eq).toHaveBeenCalledWith('tenant_id', TENANT);
    expect(qb.eq).toHaveBeenCalledWith('id', PARAMS.payslipId);
    expect(qb.eq).toHaveBeenCalledWith('salary_period', PARAMS.month);
    expect(qb.eq).toHaveBeenCalledWith('membership_id', PARAMS.membershipId);
  });

  it('a read error fails generation (not a missing-row message)', async () => {
    const { ctx } = fetchCtx({ data: null, error: { message: 'db down' } });

    await expect(fetchPayslipReportData(ctx as never)).rejects.toMatchObject({
      response: expect.objectContaining({
        message: expect.stringContaining('Failed to read'),
      }),
    });
  });

  it('a missing row says the payslip no longer exists (re-run replaced it)', async () => {
    const { ctx } = fetchCtx({ data: null, error: null });

    await expect(fetchPayslipReportData(ctx as never)).rejects.toMatchObject({
      response: expect.objectContaining({
        message: expect.stringContaining('no longer exists'),
      }),
    });
  });

  it('non-payslip params are refused before any read', async () => {
    const { ctx, qb } = fetchCtx({ data: null, error: null });

    await expect(
      fetchPayslipReportData({ ...ctx, params: {} as never } as never),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        message: expect.stringContaining('does not point at a payslip'),
      }),
    });
    expect(qb.select).not.toHaveBeenCalled();
  });
});
