import { HttpException } from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { PgPoolFactory } from '../common/pg/pg-pool.factory';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import { PayrollLockService } from './payroll-lock.service';

/**
 * lock() decides inside ONE transaction (advisory exclusive → lock probe →
 * runs read → staged count → insert), so the stand-in tx routes by SQL shape
 * and every routing change in the service fails loudly here. isLocked/get
 * stay on the supabase admin client and route by table + maybeSingle. Every
 * 409 the lock can answer gets a case proving the code AND that nothing was
 * written.
 */
type Err = { code?: string; message: string } | null;

function build(
  opts: {
    lockExists?: boolean;
    lockRowResult?: Record<string, unknown> | null;
    runRows?: Array<{ status: string }>;
    stagedCount?: number;
    insertRows?: Array<Record<string, unknown>>;
    rpcRejects?: unknown;
  } = {},
) {
  const txQueries: Array<[string, unknown[]?]> = [];
  const rpcCalls: Array<Record<string, unknown>> = [];
  const tablesRead: string[] = [];

  const tx = {
    query: jest.fn((sql: string, params?: unknown[]) => {
      txQueries.push([sql, params]);
      if (sql.includes('pg_advisory_xact_lock')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('insert into public.payroll_month_locks')) {
        return Promise.resolve({ rows: opts.insertRows ?? [] });
      }
      if (sql.includes('payroll_month_locks')) {
        return Promise.resolve({
          rows: opts.lockExists ? [{ month: '2026-10' }] : [],
        });
      }
      if (sql.includes('payroll_runs')) {
        return Promise.resolve({ rows: opts.runRows ?? [] });
      }
      if (sql.includes('payroll_off_cycle_lines')) {
        return Promise.resolve({
          rows: [{ count: String(opts.stagedCount ?? 0) }],
        });
      }
      throw new Error(`unexpected SQL in the lock tx: ${sql}`);
    }),
  };
  const pg = {
    withTransaction: jest.fn((work: (c: unknown) => Promise<unknown>) =>
      work(tx),
    ),
  } as unknown as jest.Mocked<PgPoolFactory>;

  const rpc =
    opts.rpcRejects !== undefined
      ? jest.fn().mockRejectedValue(opts.rpcRejects)
      : jest
          .fn()
          .mockImplementation((fn: string, args: Record<string, unknown>) => {
            rpcCalls.push({ fn, ...args });
            return Promise.resolve({ data: null, error: null });
          });
  const from = jest.fn((table: string) => {
    tablesRead.push(table);
    const b: Record<string, unknown> = {};
    b['eq'] = jest.fn(() => b);
    b['select'] = jest.fn(() => b);
    b['maybeSingle'] = jest.fn(() =>
      Promise.resolve({ data: opts.lockRowResult ?? null, error: null }),
    );
    return b;
  });
  const admin = { from, rpc };
  const factory = {
    createAdmin: jest.fn(() => admin),
  } as unknown as jest.Mocked<SupabaseClientFactory>;
  const service = new PayrollLockService(factory, pg);
  return { service, pg, tx, txQueries, rpcCalls, from, tablesRead };
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

const lockRow = (overrides: Record<string, unknown> = {}) => ({
  month: '2026-10',
  locked_by: 'admin-1',
  locked_at: '2026-11-18T10:00:00.000Z',
  confirmation: { statement: 'final' },
  ...overrides,
});

describe('PayrollLockService — the gates (CAP-9)', () => {
  it.each([
    ['a month never run', [] as Array<{ status: string }>],
    ['a month whose every run failed', [{ status: 'failed' }]],
  ])('refuses locking %s with run-payroll-first', async (_name, runRows) => {
    const t = build({ runRows });
    const err = await httpError(t.service.lock(companyAdmin, '2026-10'));
    expect(err.status).toBe(409);
    expect(err.body.error_code).toBe('PAYROLL_MONTH_NOT_RUN');
    expect(String(err.body.message)).toContain('run payroll first');
    // No insert was attempted — the tx's SQL log names the reads only.
    expect(
      t.txQueries.filter((c) => String(c[0]).includes('insert into')),
    ).toHaveLength(0);
  });

  it('refuses locking while the run is queued, before any state write', async () => {
    const t = build({ runRows: [{ status: 'queued' }] });
    const err = await httpError(t.service.lock(companyAdmin, '2026-10'));
    expect(err.status).toBe(409);
    expect(err.body.error_code).toBe('PAYROLL_RUN_IN_PROGRESS');
    expect(
      t.txQueries.filter((c) => String(c[0]).includes('insert into')),
    ).toHaveLength(0);
  });

  it('refuses locking while the run is running, naming the reclaim remedy', async () => {
    const t = build({ runRows: [{ status: 'running' }] });
    const err = await httpError(t.service.lock(companyAdmin, '2026-10'));
    expect(err.body.error_code).toBe('PAYROLL_RUN_IN_PROGRESS');
    expect(String(err.body.message)).toContain(
      're-running the month reclaims it',
    );
  });

  it('re-locking a locked month is a 409 naming the permanence, not a rewrite', async () => {
    const t = build({ lockExists: true });
    const err = await httpError(t.service.lock(companyAdmin, '2026-10'));
    expect(err.status).toBe(409);
    expect(err.body.error_code).toBe('PAYROLL_MONTH_LOCKED');
    expect(String(err.body.message)).toContain('cannot be undone');
    // The runs/staged reads never happened — the lock probe answers first.
    const sqls = t.txQueries.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes('payroll_runs'))).toBe(false);
    expect(sqls.some((s) => s.includes('payroll_off_cycle_lines'))).toBe(false);
  });

  it('locks a completed month: the confirmation, the view, and the audit row', async () => {
    const t = build({
      runRows: [{ status: 'failed' }, { status: 'completed' }],
      stagedCount: 2,
      insertRows: [lockRow()],
    });
    const view = await t.service.lock(companyAdmin, '2026-10');
    expect(view.month).toBe('2026-10');
    expect(view.lockedBy).toBe('admin-1');
    expect(view.lockedAt).toBe('2026-11-18T10:00:00.000Z');
    // The confirmation is asserted on what the service WROTE (the insert's
    // jsonb param, echoed back by the stand-in as the view).
    const confirmation = JSON.parse(
      String(
        t.txQueries.find((c) => String(c[0]).includes('insert into'))?.[1]?.[3],
      ),
    ) as Record<string, unknown>;
    expect(String(confirmation.statement)).toContain('2026-10');
    expect(String(confirmation.permanence)).toContain('cannot be undone');
    expect(String(confirmation.remedy)).toContain('off-cycle');
    // The month already carries two staged lines — the confirmation says so.
    expect(confirmation.stagedOffCycleLines).toBe(2);
    expect(t.rpcCalls[0]['p_action']).toBe('payroll.month_locked');
    expect(t.rpcCalls[0]['p_details']).toEqual({ month: '2026-10' });
  });

  it('holds the month advisory key EXCLUSIVELY, in the payroll-run family, before any read', async () => {
    const t = build({
      runRows: [{ status: 'completed' }],
      insertRows: [lockRow()],
    });
    await t.service.lock(companyAdmin, '2026-10');
    const first = t.txQueries[0];
    expect(String(first[0])).toContain('pg_advisory_xact_lock(');
    expect(String(first[0])).not.toContain('_shared');
    expect(String(first[1]?.[0])).toBe('payroll-run:tenant-A:2026-10');
  });

  it('a completed month with a failed run sibling still locks', async () => {
    const t = build({
      runRows: [{ status: 'failed' }, { status: 'completed' }],
      insertRows: [lockRow()],
    });
    const view = await t.service.lock(companyAdmin, '2026-10');
    expect(view.month).toBe('2026-10');
  });

  it('a concurrent lock winning the PK (empty insert) answers 409, never a second row', async () => {
    const t = build({
      runRows: [{ status: 'completed' }],
      insertRows: [],
    });
    const err = await httpError(t.service.lock(companyAdmin, '2026-10'));
    expect(err.status).toBe(409);
    expect(err.body.error_code).toBe('PAYROLL_MONTH_LOCKED');
  });

  it('an audit rpc failure never undoes the lock', async () => {
    const t = build({
      runRows: [{ status: 'completed' }],
      insertRows: [lockRow()],
      rpcRejects: new Error('rpc down'),
    });
    const view = await t.service.lock(companyAdmin, '2026-10');
    expect(view.month).toBe('2026-10');
  });

  it.each([
    ['2026-13', 'a real month'],
    ['October', 'YYYY-MM'],
    ['', 'YYYY-MM'],
  ])('a bad month "%s" is a 422 before any read', async (month) => {
    const t = build();
    const err = await httpError(t.service.lock(companyAdmin, month));
    expect(err.status).toBe(422);
    expect(t.pg.withTransaction).not.toHaveBeenCalled();
    expect(t.tablesRead).toHaveLength(0);
  });

  it('no company on the token is the 400 setup answer', async () => {
    const t = build();
    const err = await httpError(
      t.service.lock({ ...companyAdmin, tenantId: null }, '2026-10'),
    );
    expect(err.status).toBe(400);
  });
});

describe('PayrollLockService — the reads', () => {
  it('isLocked answers true only when the row exists', async () => {
    expect(
      await build({ lockRowResult: lockRow() }).service.isLocked(
        'tenant-A',
        '2026-10',
      ),
    ).toBe(true);
    expect(await build({}).service.isLocked('tenant-A', '2026-10')).toBe(false);
  });

  it('GET lock returns the lock row mapped', async () => {
    const t = build({ lockRowResult: lockRow({ confirmation: null }) });
    const view = await t.service.get(companyAdmin, '2026-10');
    expect(view.confirmation).toEqual({});
  });

  it('GET lock on an unlocked month is a plain 404', async () => {
    const t = build({});
    const err = await httpError(t.service.get(companyAdmin, '2026-10'));
    expect(err.status).toBe(404);
  });
});
