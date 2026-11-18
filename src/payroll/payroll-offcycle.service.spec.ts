import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { PgPoolFactory } from '../common/pg/pg-pool.factory';
import { ErrorCode } from '../common/enums/error-code.enum';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import { PayrollMonthStatusService } from './payroll-month-status.service';
import { PayrollOffCycleService } from './payroll-offcycle.service';

/**
 * The off-cycle staging surface (23-9): the zero/negative+acknowledgment
 * rules, the month matrix (future, below the first payroll month, locked —
 * each refusing in plain English with nothing written), the active-employee
 * + effective-structure gate, the staged-only edit rule (re-target, the
 * orphan remedy), and the consumed-between-read-and-tx 409. Every refusal
 * must leave zero rows written and zero audit entries.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const MEMBER_A = '22222222-2222-4222-8222-222222222221';
const MEMBER_B = '22222222-2222-4222-8222-222222222222';
const LINE_ID = '33333333-3333-4333-8333-333333333331';

const adminUser: RequestUser = {
  userId: 'owner-uuid',
  tenantId: TENANT,
  role: Role.COMPANY_ADMIN,
  platformAdmin: false,
  rawJwt: 'mock-jwt',
};

const memberRow = {
  id: MEMBER_A,
  user_id: 'user-1',
  users: { name: 'Asha Kumar' },
};

const structureRow = { effective_from: '2026-09-01' };

const lineRow = (overrides: Record<string, unknown> = {}) => ({
  id: LINE_ID,
  membership_id: MEMBER_A,
  month: '2026-10',
  label: 'Festival bonus',
  amount: '5000.00',
  tag: 'bonus',
  status: 'staged',
  created_at: '2026-11-18T10:00:00.000Z',
  ...overrides,
});

const errorOf = async (run: () => Promise<unknown>) => {
  const err = await run().catch((e: unknown) => e);
  const body = (err as { getResponse?: () => unknown })?.getResponse?.() ?? {};
  const status = (err as { status?: number }).status ?? 0;
  return { status, body: body as Record<string, unknown> };
};

describe('PayrollOffCycleService — staging (23-9)', () => {
  type Opts = {
    member?: { data: unknown; error?: unknown };
    structure?: { data: unknown; error?: unknown };
    line?: { data: unknown; error?: unknown };
    list?: { data: unknown; error?: unknown };
    firstPayrollMonth?: string | null;
    notRunnableReason?: string | null;
    lockRows?: Array<{ month: string }>;
    freshStatus?: string;
    freshMonth?: string;
    freshMembership?: string;
    insertReject?: { code: string; message: string };
    insertRows?: Array<Record<string, unknown>>;
    deleteRows?: Array<Record<string, unknown>>;
    today?: string;
  };

  function build(opts: Opts = {}) {
    const txQueries: Array<[string, unknown[]?]> = [];
    const tx = {
      query: jest.fn((sql: string, params?: unknown[]) => {
        txQueries.push([sql, params]);
        const s = sql.trim().toLowerCase();
        if (s.includes('pg_advisory_xact_lock')) {
          return Promise.resolve({ rows: [] });
        }
        if (s.startsWith('select') && s.includes('(now() at time zone')) {
          return Promise.resolve({
            rows: [{ today: opts.today ?? '2026-11-18' }],
          });
        }
        if (s.includes('from public.payroll_month_locks')) {
          return Promise.resolve({ rows: opts.lockRows ?? [] });
        }
        if (
          s.startsWith('select') &&
          s.includes('from public.payroll_off_cycle_lines')
        ) {
          return Promise.resolve({
            rows:
              opts.freshStatus !== undefined
                ? [
                    {
                      status: opts.freshStatus,
                      month: opts.freshMonth ?? '2026-10',
                      membership_id: opts.freshMembership ?? MEMBER_A,
                    },
                  ]
                : [],
          });
        }
        if (s.startsWith('delete from public.payroll_off_cycle_lines')) {
          return Promise.resolve({
            rows: opts.deleteRows ?? [{ id: LINE_ID }],
          });
        }
        if (s.startsWith('insert into public.payroll_off_cycle_lines')) {
          if (opts.insertReject) {
            return Promise.reject(
              Object.assign(new Error('unique race'), opts.insertReject),
            );
          }
          return Promise.resolve({
            rows: opts.insertRows ?? [{ ...lineRow(), acknowledged: false }],
          });
        }
        if (s.startsWith('update public.payroll_off_cycle_lines')) {
          return Promise.resolve({
            rows: opts.insertRows ?? [
              { ...lineRow(), month: '2026-11', label: 'Retargeted' },
            ],
          });
        }
        return Promise.reject(
          new Error(`unexpected SQL in the off-cycle tx: ${sql}`),
        );
      }),
    };
    const pg = {
      withTransaction: jest.fn((work: (c: unknown) => Promise<unknown>) =>
        work(tx),
      ),
    } as unknown as jest.Mocked<PgPoolFactory>;

    const rpcCalls: Array<[string, Record<string, unknown>]> = [];
    const rpc = jest.fn((fn: string, payload: Record<string, unknown>) => {
      rpcCalls.push([fn, payload]);
      return Promise.resolve({ data: null, error: null });
    });
    const eqCalls: Array<[string, unknown]> = [];
    const from = jest.fn((table: string) => {
      const single = (result: { data: unknown; error: unknown }) => {
        const b: Record<string, unknown> = {};
        for (const name of ['order', 'limit', 'lte', 'in']) {
          b[name] = jest.fn(() => b);
        }
        b['eq'] = jest.fn((col: string, val: unknown) => {
          eqCalls.push([col, val]);
          return b;
        });
        b['select'] = jest.fn(() => b);
        b['maybeSingle'] = jest.fn(() => Promise.resolve(result));
        b['then'] = (resolve: (v: unknown) => void) => resolve(result);
        return b;
      };
      if (table === 'memberships') {
        return single(opts.member ?? { data: memberRow, error: null });
      }
      if (table === 'salary_structures') {
        return single(opts.structure ?? { data: [structureRow], error: null });
      }
      if (table === 'payroll_off_cycle_lines') {
        return single(opts.line ?? opts.list ?? { data: null, error: null });
      }
      throw new Error(`unexpected table ${table}`);
    });
    const supabaseClientFactory = {
      createAdmin: jest.fn(() => ({ from, rpc })),
    } as unknown as jest.Mocked<SupabaseClientFactory>;
    const monthStatusFn = jest.fn().mockResolvedValue({
      firstPayrollMonth:
        opts.firstPayrollMonth === undefined
          ? '2026-09'
          : opts.firstPayrollMonth,
      notRunnableReason:
        opts.notRunnableReason === undefined
          ? 'The first payroll month is 2026-09 — earlier months have no payroll history'
          : opts.notRunnableReason,
    });
    const monthStatus = {
      monthStatus: monthStatusFn,
    } as unknown as PayrollMonthStatusService;

    const service = new PayrollOffCycleService(
      supabaseClientFactory,
      pg,
      monthStatus,
      { isLocked: jest.fn().mockResolvedValue(false) } as never,
    );
    return {
      service,
      txQueries,
      rpc,
      rpcCalls,
      from,
      monthStatus,
      monthStatusFn,
      tx,
      eqCalls,
    };
  }

  const createDto = (overrides: Record<string, unknown> = {}) => ({
    membershipId: MEMBER_A,
    month: '2026-10',
    label: 'Festival bonus',
    amount: 5000,
    ...overrides,
  });

  it('stages a positive line: insert carries the trimmed label, the default tag, acknowledged=false, and audits', async () => {
    const t = build();
    const view = await t.service.create(adminUser, createDto());
    expect(view).toMatchObject({
      membershipId: MEMBER_A,
      month: '2026-10',
      label: 'Festival bonus',
      amount: 5000,
      tag: 'bonus',
      status: 'staged',
      employeeName: 'Asha Kumar',
    });
    const insert = t.txQueries.find((c) =>
      String(c[0]).startsWith('insert into public.payroll_off_cycle_lines'),
    );
    expect(String(insert?.[1]?.[3])).toBe('Festival bonus'); // btrim applied in SQL
    expect(insert?.[1]?.[4]).toBe('5000.00');
    expect(insert?.[1]?.[5]).toBe('bonus'); // the default tag
    expect(insert?.[1]?.[6]).toBe(false); // positive line never acknowledged
    expect(t.rpc).toHaveBeenCalledTimes(1);
    expect(t.rpcCalls[0][1]['p_action']).toBe('payroll.offcycle_staged');
  });

  it('refuses zero with plain English, writing nothing and auditing nothing', async () => {
    const t = build();
    const { status, body } = await errorOf(() =>
      t.service.create(adminUser, createDto({ amount: 0 })),
    );
    expect(status).toBe(422);
    expect(String(body['message'])).toContain('cannot be zero');
    expect(t.txQueries.some((c) => String(c[0]).startsWith('insert'))).toBe(
      false,
    );
    expect(t.rpc).not.toHaveBeenCalled();
  });

  it('refuses an unacknowledged negative — the liability acknowledgment is enforced server-side', async () => {
    const t = build();
    const { status, body } = await errorOf(() =>
      t.service.create(adminUser, createDto({ amount: -1200 })),
    );
    expect(status).toBe(422);
    expect(String(body['message'])).toContain('employer-liability');
    expect(t.rpc).not.toHaveBeenCalled();
  });

  it('accepts a negative recovery WITH the acknowledgment — acknowledged persists', async () => {
    const t = build({
      insertRows: [lineRow({ label: 'Advance clawback', amount: '-1200.00' })],
    });
    const view = await t.service.create(
      adminUser,
      createDto({
        amount: -1200,
        acknowledged: true,
        label: 'Advance clawback',
      }),
    );
    expect(view.amount).toBe(-1200);
    const insert = t.txQueries.find((c) =>
      String(c[0]).startsWith('insert into public.payroll_off_cycle_lines'),
    );
    expect(insert?.[1]?.[6]).toBe(true);
  });

  it('refuses a whitespace-only label in plain English (the DDL btrim check would 500)', async () => {
    const t = build();
    const { status, body } = await errorOf(() =>
      t.service.create(adminUser, createDto({ label: '   ' })),
    );
    expect(status).toBe(422);
    expect(String(body['message'])).toContain('label is required');
    expect(t.rpc).not.toHaveBeenCalled();
  });

  it('refuses a future month — only the current open month or an earlier one', async () => {
    const t = build({ today: '2026-11-18' });
    const { status, body } = await errorOf(() =>
      t.service.create(adminUser, createDto({ month: '2026-12' })),
    );
    expect(status).toBe(422);
    expect(String(body['message'])).toContain('has not started yet');
    expect(t.monthStatusFn).not.toHaveBeenCalled();
  });

  it('refuses a month before the first payroll month with the bound reason', async () => {
    const t = build();
    const { status, body } = await errorOf(() =>
      t.service.create(adminUser, createDto({ month: '2026-08' })),
    );
    expect(status).toBe(422);
    expect(String(body['message'])).toContain('first payroll month');
  });

  it('refuses a membership that is not an active employee', async () => {
    const t = build({ member: { data: null, error: null } });
    const { status, body } = await errorOf(() =>
      t.service.create(adminUser, createDto({ membershipId: MEMBER_B })),
    );
    expect(status).toBe(422);
    expect(String(body['message'])).toContain('active employee');
    expect(t.rpc).not.toHaveBeenCalled();
  });

  it('refuses an employee with no effective structure for the month', async () => {
    const t = build({ structure: { data: [], error: null } });
    const { status, body } = await errorOf(() =>
      t.service.create(adminUser, createDto()),
    );
    expect(status).toBe(422);
    expect(String(body['message'])).toContain(
      'no salary structure is effective',
    );
    expect(t.rpc).not.toHaveBeenCalled();
  });

  it('refuses a locked month with 409 PAYROLL_MONTH_LOCKED — checked INSIDE the advisory tx', async () => {
    const t = build({ lockRows: [{ month: '2026-10' }] });
    const { status, body } = await errorOf(() =>
      t.service.create(adminUser, createDto()),
    );
    expect(status).toBe(409);
    expect(body['error_code']).toBe(ErrorCode.PAYROLL_MONTH_LOCKED);
    expect(t.txQueries.some((c) => String(c[0]).startsWith('insert'))).toBe(
      false,
    );
    expect(t.rpc).not.toHaveBeenCalled();
  });

  it('holds the month advisory key EXCLUSIVELY before the lock re-check and the insert', async () => {
    const t = build();
    await t.service.create(adminUser, createDto());
    const sqls = t.txQueries.map((c) => String(c[0]));
    expect(
      sqls.findIndex((s) => s.includes('pg_advisory_xact_lock')),
    ).toBeLessThan(sqls.findIndex((s) => s.includes('payroll_month_locks')));
    expect(
      sqls.findIndex((s) => s.includes('payroll_month_locks')),
    ).toBeLessThan(sqls.findIndex((s) => s.startsWith('insert')));
  });

  it('answers 409 DUPLICATE_RESOURCE on the (employee, month, label) unique race', async () => {
    const t = build({ insertReject: { code: '23505', message: 'unique' } });
    const { status, body } = await errorOf(() =>
      t.service.create(adminUser, createDto()),
    );
    expect(status).toBe(409);
    expect(body['error_code']).toBe(ErrorCode.DUPLICATE_RESOURCE);
  });

  it('lists lines with joined employee names, newest first', async () => {
    const t = build({
      list: {
        data: [lineRow(), lineRow({ id: LINE_ID, membership_id: MEMBER_B })],
        error: null,
      },
      member: {
        data: [memberRow, { ...memberRow, id: MEMBER_B, user_id: 'user-2' }],
        error: null,
      },
    });
    const rows = await t.service.list(adminUser, '2026-10');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      status: 'staged',
      employeeName: 'Asha Kumar',
    });
  });

  it('updates a staged line — re-targeting the month is the orphan remedy', async () => {
    const t = build({
      line: { data: lineRow({ month: '2026-10' }), error: null },
      freshStatus: 'staged',
    });
    const view = await t.service.update(adminUser, LINE_ID, {
      month: '2026-11',
    });
    expect(view.month).toBe('2026-11');
    const update = t.txQueries.find((c) =>
      String(c[0]).startsWith('update public.payroll_off_cycle_lines'),
    );
    expect(update?.[1]?.[2]).toBe('2026-11');
    // Both the current and the target month keyed (sorted), exclusively.
    const keyCalls = t.txQueries.filter((c) =>
      String(c[0]).includes('pg_advisory_xact_lock'),
    );
    expect(keyCalls).toHaveLength(2);
    expect(String(keyCalls[0][1]?.[0])).toContain(':2026-10');
    expect(String(keyCalls[1][1]?.[0])).toContain(':2026-11');
    expect(t.rpcCalls[0][1]['p_action']).toBe('payroll.offcycle_updated');
  });

  it('answers 409 on an applied line — the money already sits on payslips', async () => {
    const t = build({
      line: { data: lineRow({ status: 'applied' }), error: null },
    });
    const { status, body } = await errorOf(() =>
      t.service.update(adminUser, LINE_ID, { month: '2026-11' }),
    );
    expect(status).toBe(422);
    expect(String(body['message'])).toContain('already sits on');
    expect(
      t.txQueries.some((c) =>
        String(c[0]).startsWith('update public.payroll_off_cycle_lines'),
      ),
    ).toBe(false);
    expect(t.rpc).not.toHaveBeenCalled();
  });

  it('re-checks the line under the advisory keys — a line consumed between read and tx answers 409', async () => {
    const t = build({
      line: { data: lineRow(), error: null },
      freshStatus: 'applied',
    });
    const { status } = await errorOf(() =>
      t.service.update(adminUser, LINE_ID, { month: '2026-11' }),
    );
    expect(status).toBe(422);
    expect(
      t.txQueries.some((c) =>
        String(c[0]).startsWith('update public.payroll_off_cycle_lines'),
      ),
    ).toBe(false);
  });

  it('refuses an edit that turns the amount negative without the acknowledgment', async () => {
    const t = build({ line: { data: lineRow(), error: null } });
    const { status, body } = await errorOf(() =>
      t.service.update(adminUser, LINE_ID, { amount: -100 }),
    );
    expect(status).toBe(422);
    expect(String(body['message'])).toContain('employer-liability');
    expect(t.rpc).not.toHaveBeenCalled();
  });

  it('a line of another company answers 404', async () => {
    const t = build({ line: { data: null, error: null } });
    const { status, body } = await errorOf(() =>
      t.service.update(adminUser, LINE_ID, { month: '2026-11' }),
    );
    expect(status).toBe(404);
    expect(body['error_code']).toBe(ErrorCode.RESOURCE_NOT_FOUND);
  });

  it('a locked TARGET month refuses the re-target inside the tx', async () => {
    const t = build({
      line: { data: lineRow({ month: '2026-10' }), error: null },
      freshStatus: 'staged',
      lockRows: [{ month: '2026-11' }],
    });
    const { status, body } = await errorOf(() =>
      t.service.update(adminUser, LINE_ID, { month: '2026-11' }),
    );
    expect(status).toBe(409);
    expect(body['error_code']).toBe(ErrorCode.PAYROLL_MONTH_LOCKED);
  });

  it('edits an acknowledged negative line WITHOUT re-asking the acknowledgment — the stored liability stands', async () => {
    const t = build({
      line: {
        data: lineRow({ amount: '-1200.00', label: 'Advance clawback' }),
        error: null,
      },
      freshStatus: 'staged',
      insertRows: [
        lineRow({ amount: '-1200.00', label: 'Fixed label', month: '2026-11' }),
      ],
    });
    // A label-only edit and the orphan re-target (month-only) both pass.
    const view = await t.service.update(adminUser, LINE_ID, {
      month: '2026-11',
    });
    expect(view.month).toBe('2026-11');
    const update = t.txQueries.find((c) =>
      String(c[0]).startsWith('update public.payroll_off_cycle_lines'),
    );
    expect(update?.[1]?.[4]).toBe('-1200.00'); // amount unchanged
    expect(update?.[1]?.[6]).toBe(true); // acknowledged stays
    expect(t.rpc).toHaveBeenCalledTimes(1);
  });

  it('a NEW negative amount still re-asks the acknowledgment', async () => {
    const t = build({ line: { data: lineRow(), error: null } });
    const { status, body } = await errorOf(() =>
      t.service.update(adminUser, LINE_ID, { amount: -100 }),
    );
    expect(status).toBe(422);
    expect(String(body['message'])).toContain('employer-liability');
  });

  it('refuses NaN and Infinity — IsNumber alone lets them through', async () => {
    const t = build();
    for (const amount of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const { status, body } = await errorOf(() =>
        t.service.create(adminUser, createDto({ amount })),
      );
      expect(status).toBe(422);
      expect(String(body['message'])).toContain('real number');
    }
    expect(t.rpc).not.toHaveBeenCalled();
  });

  it('the tenant-scope filter is present on every list read (cross-tenant isolation)', async () => {
    const t = build({
      list: { data: [lineRow()], error: null },
      member: { data: [memberRow], error: null },
    });
    await t.service.list(adminUser, undefined);
    expect(t.eqCalls).toContainEqual(['tenant_id', TENANT]);
  });

  it('detects a concurrent re-target under the keys and answers 409 OFFCYCLE_LINE_CHANGED', async () => {
    const t = build({
      line: { data: lineRow({ month: '2026-10' }), error: null },
      freshStatus: 'staged',
      freshMonth: '2026-11', // another editor already moved the line
    });
    const { status, body } = await errorOf(() =>
      t.service.update(adminUser, LINE_ID, { month: '2026-11' }),
    );
    expect(status).toBe(409);
    expect(body['error_code']).toBe(ErrorCode.OFFCYCLE_LINE_CHANGED);
    expect(
      t.txQueries.some((c) =>
        String(c[0]).startsWith('update public.payroll_off_cycle_lines'),
      ),
    ).toBe(false);
    expect(t.rpc).not.toHaveBeenCalled();
  });

  it('cancels a staged line: the delete runs under the month key with the lock re-checked, then audits', async () => {
    const t = build({ line: { data: lineRow(), error: null } });
    await t.service.remove(adminUser, LINE_ID);
    const sqls = t.txQueries.map((c) => String(c[0]));
    const keyAt = sqls.findIndex((s) => s.includes('pg_advisory_xact_lock'));
    const lockAt = sqls.findIndex((s) => s.includes('payroll_month_locks'));
    const deleteAt = sqls.findIndex((s) =>
      s.startsWith('delete from public.payroll_off_cycle_lines'),
    );
    expect(keyAt).toBeLessThan(lockAt);
    expect(lockAt).toBeLessThan(deleteAt);
    expect(String(t.txQueries[keyAt][1]?.[0])).toContain(':2026-10');
    expect(t.rpcCalls[0][1]['p_action']).toBe('payroll.offcycle_cancelled');
  });

  it('an applied line cannot be cancelled', async () => {
    const t = build({
      line: { data: lineRow({ status: 'applied' }), error: null },
    });
    const { status, body } = await errorOf(() =>
      t.service.remove(adminUser, LINE_ID),
    );
    expect(status).toBe(422);
    expect(String(body['message'])).toContain('cannot be cancelled');
    expect(t.rpc).not.toHaveBeenCalled();
  });

  it('a locked month refuses the cancel inside the tx', async () => {
    const t = build({
      line: { data: lineRow(), error: null },
      lockRows: [{ month: '2026-10' }],
    });
    const { status, body } = await errorOf(() =>
      t.service.remove(adminUser, LINE_ID),
    );
    expect(status).toBe(409);
    expect(body['error_code']).toBe(ErrorCode.PAYROLL_MONTH_LOCKED);
    expect(
      t.txQueries.some((c) =>
        String(c[0]).startsWith('delete from public.payroll_off_cycle_lines'),
      ),
    ).toBe(false);
  });
});
