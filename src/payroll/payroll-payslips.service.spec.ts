import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { StorageService } from '../storage/storage.service';
import { ConfigService } from '@nestjs/config';
import { ErrorCode } from '../common/enums/error-code.enum';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import { PT_IN_FLIGHT_LIMIT } from '../reports/reports.service';
import { PayrollMonthStatusService } from './payroll-month-status.service';
import { PayrollPayslipsService } from './payroll-payslips.service';

/**
 * The payslip PDF queueing surface (23-8): both PDF POSTs queue through
 * report_requests with the shared PT429 SQLSTATE mapping — the declarative
 * in-flight cap trigger answers 429 REPORT_IN_FLIGHT_LIMIT, the same
 * contract as the generic POST /reports route, on BOTH entry points.
 */

const TENANT = 'tenant-uuid';
const MEMBERSHIP = '00000000-0000-4000-8000-0000000000b1';
const PAYSLIP_ID = '00000000-0000-4000-8000-0000000000c1';
const MONTH = '2026-10';

const ownerUser: RequestUser = {
  userId: 'owner-uuid',
  tenantId: TENANT,
  role: Role.COMPANY_ADMIN,
  platformAdmin: false,
  rawJwt: 'mock-jwt',
};

describe('PayrollPayslipsService — PDF queueing (23-8)', () => {
  let service: PayrollPayslipsService;
  let supabaseClientFactory: jest.Mocked<SupabaseClientFactory>;
  let monthStatus: { monthStatus: jest.Mock };

  /** A payslip row as the lookup reads it (id + membership + month is all the insert needs). */
  const slipRow = {
    id: PAYSLIP_ID,
    membership_id: MEMBERSHIP,
    salary_period: MONTH,
  };

  /**
   * The three chains both POSTs touch:
   *  - the payslip lookup (select('id, membership_id, salary_period') or the
   *    full PAYSLIP_COLUMNS read), ending in maybeSingle;
   *  - the newest-request read (select('id, params, status, r2_key, ...')
   *    .contains.order.order.limit.maybeSingle);
   *  - the plain INSERT into report_requests.
   * `from` dispatches on the select columns string.
   */
  function mockAdmin(opts: {
    slip?: { data: unknown; error: unknown };
    newest?: { data: unknown; error: unknown };
    insert?: { data: unknown; error: unknown };
  }) {
    const slipQb = maybeSingleChain(
      opts.slip ?? { data: slipRow, error: null },
    );
    const newestQb = newestChain(opts.newest ?? { data: null, error: null });
    const insertPayloads: Record<string, unknown>[] = [];
    // The queue insert is insert(...).select('*').single() — chained.
    const insert = jest.fn((payload: Record<string, unknown>) => {
      insertPayloads.push(payload);
      return {
        select: jest.fn().mockReturnValue({
          single: jest.fn().mockResolvedValue(
            opts.insert ?? {
              data: { id: 'req-1', status: 'queued', created_at: 'now' },
              error: null,
            },
          ),
        }),
      };
    });
    const from = jest.fn((table: string) => {
      if (table !== 'payroll_payslips' && table !== 'report_requests') {
        throw new Error(`unexpected table ${table}`);
      }
      return {
        select: jest.fn((cols: string) => {
          if (cols === 'id, membership_id, salary_period') {
            return slipQb;
          }
          if (cols.startsWith('id, tenant_id')) {
            return slipQb; // PAYSLIP_COLUMNS read (/me routes)
          }
          if (cols.startsWith('id, params')) {
            return newestQb;
          }
          throw new Error(`unexpected select ${cols}`);
        }),
        insert,
      };
    });
    supabaseClientFactory.createAdmin.mockReturnValue({ from } as never);
    return { insert, insertPayloads, from, newestQb };
  }

  /** select(...).eq.eq.eq.maybeSingle — the tenant-scoped slip lookup
   *  (self-referential: each filter is called once, so the qb chains to itself). */
  function maybeSingleChain(result: { data: unknown; error: unknown }) {
    const qb: Record<string, jest.Mock> = {} as never;
    qb.eq = jest.fn().mockReturnValue(qb);
    qb.maybeSingle = jest.fn().mockResolvedValue(result);
    return qb;
  }

  /** select(...).eq.eq.contains.order.order.limit.maybeSingle — the
   *  newest-request read (self-referential). */
  function newestChain(result: { data: unknown; error: unknown }) {
    const qb: Record<string, jest.Mock> = {} as never;
    for (const m of ['eq', 'contains', 'order', 'limit']) {
      qb[m] = jest.fn().mockReturnValue(qb);
    }
    qb.maybeSingle = jest.fn().mockResolvedValue(result);
    return qb;
  }

  beforeEach(async () => {
    const mockFactory = { create: jest.fn(), createAdmin: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PayrollPayslipsService,
        { provide: SupabaseClientFactory, useValue: mockFactory },
        { provide: StorageService, useValue: {} },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        {
          provide: PayrollMonthStatusService,
          useValue: { monthStatus: jest.fn() },
        },
      ],
    }).compile();
    service = module.get<PayrollPayslipsService>(PayrollPayslipsService);
    supabaseClientFactory = module.get(SupabaseClientFactory);
    monthStatus = module.get(PayrollMonthStatusService);
  });

  it('POST /:membershipId/:month/pdf maps the PT429 in-flight trigger to 429 REPORT_IN_FLIGHT_LIMIT', async () => {
    const { insert, insertPayloads } = mockAdmin({
      insert: {
        data: null,
        error: { code: PT_IN_FLIGHT_LIMIT, message: 'cap' },
      },
    });

    await expect(
      service.requestPdfFor(ownerUser, MEMBERSHIP, MONTH),
    ).rejects.toMatchObject({
      status: 429,
      response: { error_code: ErrorCode.REPORT_IN_FLIGHT_LIMIT },
    });
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insertPayloads[0]).toMatchObject({
      tenant_id: TENANT,
      requested_by: 'owner-uuid',
      report_type: 'payslip',
      params: { month: MONTH, membershipId: MEMBERSHIP, payslipId: PAYSLIP_ID },
    });
  });

  it('POST /me/:month/pdf maps the PT429 in-flight trigger to 429 too (same contract, employee surface)', async () => {
    monthStatus.monthStatus.mockResolvedValue({
      notRunnableReason: null,
      locked: true,
    });
    const { insert, insertPayloads } = mockAdmin({
      insert: {
        data: null,
        error: { code: PT_IN_FLIGHT_LIMIT, message: 'cap' },
      },
    });

    const err: HttpException = await service
      .requestPdfOwn(ownerUser, MONTH)
      .then(
        () => {
          throw new Error('expected a 429');
        },
        (e) => e,
      );

    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(429);
    expect((err.getResponse() as Record<string, unknown>).error_code).toBe(
      ErrorCode.REPORT_IN_FLIGHT_LIMIT,
    );
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insertPayloads[0]).toMatchObject({
      tenant_id: TENANT,
      requested_by: 'owner-uuid',
      report_type: 'payslip',
      params: { month: MONTH, membershipId: MEMBERSHIP, payslipId: PAYSLIP_ID },
    });
  });

  it('a still in-flight (queued) request is RETURNED, not duplicated — no second insert', async () => {
    const { insert, insertPayloads } = mockAdmin({
      newest: {
        data: {
          id: 'req-live',
          params: null,
          status: 'queued',
          r2_key: null,
          created_at: 'now',
        },
        error: null,
      },
    });

    const result = await service.requestPdfFor(ownerUser, MEMBERSHIP, MONTH);

    expect(result).toMatchObject({ id: 'req-live', status: 'queued' });
    // The load-bearing half: the in-flight slot is NOT burned twice.
    expect(insert).not.toHaveBeenCalled();
    expect(insertPayloads).toHaveLength(0);
  });

  it('a GENERATING request is deduped the same way (mid-render re-tap returns the live row)', async () => {
    const { insert } = mockAdmin({
      newest: {
        data: {
          id: 'req-rendering',
          params: null,
          status: 'generating',
          r2_key: null,
          created_at: 'now',
        },
        error: null,
      },
    });

    const result = await service.requestPdfFor(ownerUser, MEMBERSHIP, MONTH);

    expect(result).toMatchObject({ id: 'req-rendering', status: 'generating' });
    expect(insert).not.toHaveBeenCalled();
  });

  it('a READY request does not dedupe — a re-request inserts a fresh row (regeneration semantics)', async () => {
    const { insert } = mockAdmin({
      newest: {
        data: {
          id: 'req-done',
          params: null,
          status: 'ready',
          r2_key: 'k',
          created_at: 'now',
        },
        error: null,
      },
    });

    const result = await service.requestPdfFor(ownerUser, MEMBERSHIP, MONTH);

    expect(result.id).not.toBe('req-done');
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('the dedupe read is scoped: tenant + payslip type + the FULL params triple', async () => {
    const { newestQb } = mockAdmin({});

    await service.requestPdfFor(ownerUser, MEMBERSHIP, MONTH);

    // The newest-request read pins all three scopes — a cross-tenant or
    // cross-type dedupe leak fails here.
    expect(newestQb.eq).toHaveBeenCalledWith('tenant_id', TENANT);
    expect(newestQb.eq).toHaveBeenCalledWith('report_type', 'payslip');
    expect(newestQb.contains).toHaveBeenCalledWith('params', {
      month: MONTH,
      membershipId: MEMBERSHIP,
      payslipId: PAYSLIP_ID,
    });
    expect(newestQb.order).toHaveBeenCalledWith('created_at', {
      ascending: false,
    });
    expect(newestQb.order).toHaveBeenCalledWith('id', { ascending: false });
    expect(newestQb.limit).toHaveBeenCalledWith(1);
  });

  it('a TERMINAL (failed) request never blocks a re-request — a fresh row is inserted', async () => {
    const { insert, insertPayloads } = mockAdmin({
      newest: {
        data: {
          id: 'req-old-failed',
          params: null,
          status: 'failed',
          r2_key: null,
          created_at: 'now',
        },
        error: null,
      },
    });

    const result = await service.requestPdfFor(ownerUser, MEMBERSHIP, MONTH);

    expect(result).toMatchObject({ status: 'queued' });
    expect(result.id).not.toBe('req-old-failed');
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('a failed DEDUPE read is an honest 500 — never a duplicate insert on a broken read', async () => {
    const { insert } = mockAdmin({
      newest: { data: null, error: { message: 'db down' } },
    });

    await expect(
      service.requestPdfFor(ownerUser, MEMBERSHIP, MONTH),
    ).rejects.toMatchObject({ status: 500 });
    expect(insert).not.toHaveBeenCalled();
  });

  it('a non-PT429 insert error is a 500 INTERNAL_SERVER_ERROR, not a 429', async () => {
    mockAdmin({
      insert: { data: null, error: { code: '23505', message: 'duplicate' } },
    });

    await expect(
      service.requestPdfFor(ownerUser, MEMBERSHIP, MONTH),
    ).rejects.toMatchObject({ status: 500 });
  });

  it('a failed SLIP-LOOKUP read is a 500 — the branched 404 is for a MISSING row only', async () => {
    mockAdmin({ slip: { data: null, error: { message: 'db down' } } });

    await expect(
      service.requestPdfFor(ownerUser, MEMBERSHIP, MONTH),
    ).rejects.toMatchObject({ status: 500 });
  });

  it('requestPdfFor validates month shape and membershipId uuid before any DB call', async () => {
    const { from } = mockAdmin({});

    await expect(
      service.requestPdfFor(ownerUser, MEMBERSHIP, '2026-13'),
    ).rejects.toMatchObject({
      response: { error_code: ErrorCode.VALIDATION_ERROR },
    });
    await expect(
      service.requestPdfFor(ownerUser, 'not-a-uuid', MONTH),
    ).rejects.toMatchObject({
      response: { error_code: ErrorCode.VALIDATION_ERROR },
    });
    expect(from).not.toHaveBeenCalled();
  });

  it('a month with no payslip row answers the branched 404 and never queues', async () => {
    const { insert, insertPayloads } = mockAdmin({
      slip: { data: null, error: null },
    });

    await expect(
      service.requestPdfFor(ownerUser, MEMBERSHIP, MONTH),
    ).rejects.toMatchObject({
      status: 404,
      response: expect.objectContaining({
        error_code: ErrorCode.RESOURCE_NOT_FOUND,
      }),
    });
    expect(insert).not.toHaveBeenCalled();
  });
});

describe('PayrollPayslipsService — the leave_balances mapping (23-13)', () => {
  let service: PayrollPayslipsService;
  let supabaseClientFactory: jest.Mocked<SupabaseClientFactory>;

  beforeEach(async () => {
    const mockFactory = { create: jest.fn(), createAdmin: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PayrollPayslipsService,
        { provide: SupabaseClientFactory, useValue: mockFactory },
        { provide: StorageService, useValue: {} },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        {
          provide: PayrollMonthStatusService,
          useValue: { monthStatus: jest.fn() },
        },
      ],
    }).compile();
    service = module.get<PayrollPayslipsService>(PayrollPayslipsService);
    supabaseClientFactory = module.get(SupabaseClientFactory);
  });

  /** select().eq().eq().order() (the list read) and the request join — both
   *  self-chaining thenables answering the staged result. */
  function chainQb(result: { data: unknown; error: unknown }) {
    const qb: Record<string, unknown> = {};
    const self = () => qb;
    for (const m of ['eq', 'order', 'in', 'contains', 'limit']) {
      qb[m] = jest.fn(self);
    }
    qb.select = jest.fn(self);
    qb.then = (resolve: (v: unknown) => void) => resolve(result);
    return qb;
  }

  const row = {
    id: PAYSLIP_ID,
    tenant_id: TENANT,
    membership_id: MEMBERSHIP,
    user_id: 'user-uuid',
    run_id: 'run-uuid',
    salary_period: MONTH,
    slip_number: 'PS-2026-10-0001',
    employee_name: 'Asha Nair',
    employee_code: 'EMP-001',
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
    pay_date: null,
    payable_days: 30,
    lop_days: 1,
    paid_days: 29,
    days_worked: null,
    gross_earnings: '10000.00',
    pf_employee: '780.00',
    pf_employer: '780.00',
    tds: '500.00',
    other_deductions: '350.00',
    total_deductions: '1770.00',
    net_wages: '8230.00',
    earning_lines: [],
    deduction_lines: [],
    leave_balances: [
      // jsonb arrives parsed — but the Number() idiom must survive a
      // string-typed figure too (the null-safe defensive path).
      {
        code: 'earned',
        name: 'Earned Leave',
        accrued: 6,
        availed: '1.5',
        carryForward: 0,
        remaining: '4.5',
      },
    ],
    warnings: [],
    created_at: '2026-11-01T00:00:00Z',
  };

  function mockFrom() {
    const from = jest.fn((table: string) =>
      table === 'payroll_payslips'
        ? chainQb({ data: [row], error: null })
        : chainQb({ data: [], error: null }),
    );
    supabaseClientFactory.createAdmin.mockReturnValue({ from } as never);
  }

  it('maps the snapshot rows to the camelCase view with numbers coerced', async () => {
    mockFrom();
    const views = await service.adminList(ownerUser, MONTH);
    expect(views).toHaveLength(1);
    expect(views[0].leaveBalances).toEqual([
      {
        code: 'earned',
        name: 'Earned Leave',
        accrued: 6,
        availed: 1.5,
        carryForward: 0,
        remaining: 4.5,
      },
    ]);
  });

  it('a null column answers an empty array, never a crash', async () => {
    mockFrom();
    // A pre-capture row (default '[]' is guaranteed, but null-safety is the
    // idiom every other jsonb column follows).
    const nullRow = { ...row, leave_balances: null };
    const from = jest.fn((table: string) =>
      table === 'payroll_payslips'
        ? chainQb({ data: [nullRow], error: null })
        : chainQb({ data: [], error: null }),
    );
    supabaseClientFactory.createAdmin.mockReturnValue({ from } as never);
    const views = await service.adminList(ownerUser, MONTH);
    expect(views[0].leaveBalances).toEqual([]);
  });
});
