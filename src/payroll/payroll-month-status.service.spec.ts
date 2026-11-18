import { HttpException } from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import {
  CALENDAR_DEFAULTS,
  PayrollMonthStatusService,
} from './payroll-month-status.service';

/**
 * The month-status read is the run engine's config surface: month-start
 * resolution with the defaults when nothing governs, the bound derived live
 * from active employee join dates, and plain-English reasons for every
 * not-runnable answer. The fake routes calendar reads (ordered) vs
 * membership reads (join_date rows) vs the month-lock probe (23-7).
 */
function build(
  opts: {
    calendarRows?: Array<Record<string, unknown>>;
    calendarError?: { code?: string; message: string } | null;
    joinRows?: Array<Record<string, unknown>>;
    joinsError?: { code?: string; message: string } | null;
    lockRow?: Record<string, unknown> | null;
    lockError?: { code?: string; message: string } | null;
  } = {},
) {
  const mkBuilder = (table: string) => {
    const b: Record<string, unknown> = {};
    let limitCount: number | null = null;
    for (const name of ['eq', 'select', 'maybeSingle']) {
      b[name] = jest.fn(() => b);
    }
    b['not'] = jest.fn(() => b);
    b['order'] = jest.fn(() => b);
    b['limit'] = jest.fn((n: number) => {
      limitCount = n;
      return b;
    });
    b['then'] = (resolve: (v: unknown) => void) => {
      if (table === 'payroll_calendar') {
        resolve({
          data: opts.calendarRows ?? [],
          error: opts.calendarError ?? null,
        });
        return;
      }
      if (table === 'payroll_month_locks') {
        resolve({ data: opts.lockRow ?? null, error: opts.lockError ?? null });
        return;
      }
      // memberships — the bound read. Postgres honours the order+limit, so
      // the stand-in sorts by join_date and hands back only the limit rows:
      // the service must use what the DB's minimum query returns.
      const rows = [...(opts.joinRows ?? [])].sort((x, y) =>
        String(x['join_date']).localeCompare(String(y['join_date'])),
      );
      resolve({
        data: limitCount === null ? rows : rows.slice(0, limitCount),
        error: opts.joinsError ?? null,
      });
    };
    return b;
  };

  const builders: Array<Record<string, unknown>> = [];
  const from = jest.fn((table: string) => {
    const builder = mkBuilder(table);
    builders.push(builder);
    return builder;
  });
  const rpc = jest.fn();
  const admin = { from, rpc };
  const factory = {
    createAdmin: jest.fn(() => admin),
  } as unknown as jest.Mocked<SupabaseClientFactory>;
  const service = new PayrollMonthStatusService(factory);
  return { service, from, rpc, builders };
}

/** The builder of the nth from() probe (0 = calendar, 1 = memberships). */
function builderOf(
  t: { builders: Array<Record<string, unknown>> },
  index: number,
): Record<string, jest.Mock> {
  return t.builders[index] as unknown as Record<string, jest.Mock>;
}

/** Captures the HttpException a refused call must raise, typed. */
async function httpError(
  promise: Promise<unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    await promise;
    throw new Error('expected the call to be refused');
  } catch (e) {
    const http = e as HttpException;
    return {
      status: http.getStatus(),
      body: http.getResponse() as Record<string, unknown>,
    };
  }
}

const companyAdmin: RequestUser = {
  userId: 'admin-1',
  tenantId: 'tenant-A',
  role: Role.COMPANY_ADMIN,
  platformAdmin: false,
  rawJwt: 'jwt',
};

describe('PayrollMonthStatusService — defaults and resolution', () => {
  it('answers the fixture defaults when no calendar rows exist', async () => {
    const t = build({
      joinRows: [{ join_date: '2026-09-01' }],
    });
    const view = await t.service.monthStatus(companyAdmin, '2026-10');
    expect(view).toMatchObject({
      month: '2026-10',
      divisorConvention: CALENDAR_DEFAULTS.divisorConvention,
      cutoffDay: CALENDAR_DEFAULTS.cutoffDay,
      payDate: CALENDAR_DEFAULTS.payDate,
      effectiveFrom: null,
      locked: false,
      firstPayrollMonth: '2026-09',
      notRunnableReason: null,
    });
  });

  it('resolves the dated row that governs the month (month-start)', async () => {
    const t = build({
      calendarRows: [
        {
          effective_from: '2026-10-01',
          divisor_convention: 'fixed-30',
          cutoff_day: 20,
          pay_date: 5,
        },
      ],
      joinRows: [{ join_date: '2026-09-01' }],
    });
    const oct = await t.service.monthStatus(companyAdmin, '2026-10');
    expect(oct).toMatchObject({
      divisorConvention: 'fixed-30',
      cutoffDay: 20,
      payDate: 5,
      effectiveFrom: '2026-10-01',
    });
    // September's first day predates the row: the defaults govern.
    const sep = await t.service.monthStatus(companyAdmin, '2026-09');
    expect(sep).toMatchObject({
      divisorConvention: CALENDAR_DEFAULTS.divisorConvention,
      effectiveFrom: null,
    });
  });

  it('a mid-month-dated change is invisible to its own month, visible the next', async () => {
    const rows = [
      {
        effective_from: '2026-11-10',
        divisor_convention: 'calendar',
        cutoff_day: 15,
        pay_date: 3,
      },
    ];
    const t = build({
      calendarRows: rows,
      joinRows: [{ join_date: '2026-09-01' }],
    });
    const nov = await t.service.monthStatus(companyAdmin, '2026-11');
    expect(nov.effectiveFrom).toBeNull();
    const dec = await t.service.monthStatus(companyAdmin, '2026-12');
    expect(dec).toMatchObject({
      divisorConvention: 'calendar',
      cutoffDay: 15,
      effectiveFrom: '2026-11-10',
    });
  });

  it('picks the latest qualifying row among unordered input', async () => {
    const t = build({
      calendarRows: [
        {
          effective_from: '2026-12-01',
          divisor_convention: 'calendar',
          cutoff_day: 5,
          pay_date: 2,
        },
        {
          effective_from: '2026-10-01',
          divisor_convention: 'fixed-30',
          cutoff_day: 20,
          pay_date: 5,
        },
        {
          effective_from: '2026-11-01',
          divisor_convention: 'fixed-26',
          cutoff_day: 10,
          pay_date: 1,
        },
      ],
      joinRows: [{ join_date: '2026-09-01' }],
    });
    const view = await t.service.monthStatus(companyAdmin, '2026-11');
    expect(view.divisorConvention).toBe('fixed-26');
    expect(view.cutoffDay).toBe(10);
  });
});

describe('PayrollMonthStatusService — the bound and its reasons', () => {
  it('a month before the bound is not runnable, with the bound named', async () => {
    const t = build({ joinRows: [{ join_date: '2026-09-01' }] });
    const view = await t.service.monthStatus(companyAdmin, '2026-08');
    expect(view.firstPayrollMonth).toBe('2026-09');
    expect(view.notRunnableReason).toContain('2026-09');
    expect(view.notRunnableReason).toContain('no payroll history');
  });

  it('no join dates anywhere means no bound, with the setup reason', async () => {
    const t = build({ joinRows: [] });
    const view = await t.service.monthStatus(companyAdmin, '2026-10');
    expect(view.firstPayrollMonth).toBeNull();
    expect(view.notRunnableReason).toContain('joining date');
  });

  it('the bound month itself is runnable (equality is not "before")', async () => {
    const t = build({ joinRows: [{ join_date: '2026-09-01' }] });
    const view = await t.service.monthStatus(companyAdmin, '2026-09');
    expect(view.firstPayrollMonth).toBe('2026-09');
    expect(view.notRunnableReason).toBeNull();
  });

  it('the bound probe filters to active employees and asks the DB for the minimum', async () => {
    const t = build({ joinRows: [{ join_date: '2026-09-01' }] });
    await t.service.monthStatus(companyAdmin, '2026-10');
    const b = builderOf(t, 1);
    expect(b['eq']).toHaveBeenCalledWith('tenant_id', 'tenant-A');
    expect(b['eq']).toHaveBeenCalledWith('role', 'employee');
    expect(b['eq']).toHaveBeenCalledWith('status', 'active');
    expect(b['not']).toHaveBeenCalledWith('join_date', 'is', null);
    expect(b['order']).toHaveBeenCalledWith('join_date', { ascending: true });
    expect(b['limit']).toHaveBeenCalledWith(1);
  });

  it('the bound is the EARLIEST join month among active employees', async () => {
    const t = build({
      joinRows: [
        { join_date: '2026-10-20' },
        { join_date: '2026-09-15' },
        { join_date: '2026-11-01' },
      ],
    });
    const view = await t.service.monthStatus(companyAdmin, '2026-10');
    expect(view.firstPayrollMonth).toBe('2026-09');
  });
});

describe('PayrollMonthStatusService — the lock flag (23-7)', () => {
  it('a month with a lock row reads locked: true, others false', async () => {
    const locked = build({
      joinRows: [{ join_date: '2026-09-01' }],
      lockRow: { month: '2026-10' },
    });
    expect(
      (await locked.service.monthStatus(companyAdmin, '2026-10')).locked,
    ).toBe(true);
    const unlocked = build({ joinRows: [{ join_date: '2026-09-01' }] });
    expect(
      (await unlocked.service.monthStatus(companyAdmin, '2026-10')).locked,
    ).toBe(false);
    // The lock probe filtered to the asked month and asked for one row.
    const b = builderOf(locked, 2);
    expect(b['eq']).toHaveBeenCalledWith('month', '2026-10');
  });
});

describe('PayrollMonthStatusService — boundaries', () => {
  it.each([
    ['2026-13', 'real month'],
    ['2026-00', 'real month'],
    ['2026-1', 'YYYY-MM'],
    ['2026-10-01', 'YYYY-MM'],
    ['october', 'YYYY-MM'],
  ])('rejects the month key %p with a 400', async (month, text) => {
    const t = build();
    const err = await httpError(t.service.monthStatus(companyAdmin, month));
    expect(err.status).toBe(400);
    expect(String(err.body['message'])).toContain(text);
    expect(t.from).not.toHaveBeenCalled();
  });

  it('a calendar read failure is a 500 without DB text', async () => {
    const t = build({ calendarError: { code: 'XX000', message: 'boom' } });
    const err = await httpError(t.service.monthStatus(companyAdmin, '2026-10'));
    expect(err.status).toBe(500);
    expect(String(err.body['message'])).not.toContain('boom');
  });

  it('a join-dates read failure is a 500, never a fake "no joining date" answer', async () => {
    const t = build({ joinsError: { code: 'XX000', message: 'boom' } });
    const err = await httpError(t.service.monthStatus(companyAdmin, '2026-10'));
    expect(err.status).toBe(500);
    expect(String(err.body['message'])).not.toContain('boom');
    expect(String(err.body['message'])).not.toContain('joining date');
  });

  it('a lock read failure is a 500, never a fake "unlocked" answer', async () => {
    const t = build({
      joinRows: [{ join_date: '2026-09-01' }],
      lockError: { code: 'XX000', message: 'boom' },
    });
    const err = await httpError(t.service.monthStatus(companyAdmin, '2026-10'));
    expect(err.status).toBe(500);
    expect(String(err.body['message'])).not.toContain('boom');
  });

  it('a caller with no company is a 400 before any query', async () => {
    const t = build();
    const err = await httpError(
      t.service.monthStatus({ ...companyAdmin, tenantId: null }, '2026-10'),
    );
    expect(err.status).toBe(400);
    expect(t.from).not.toHaveBeenCalled();
  });
});
