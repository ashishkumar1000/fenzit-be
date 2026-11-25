import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { PgPoolFactory } from '../common/pg/pg-pool.factory';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import {
  LeaveBalanceService,
  assertBalanceForApply,
  captureForRun,
  readBalancesFor,
} from './leave-balance.service';
import type { PoolClient } from 'pg';

/**
 * The derived-balance module's decision pins (23-13). The real SQL,
 * constraints and multi-FY chains are proven by the real-DB journey and
 * the math spec; these pins would survive any refactoring that keeps the
 * decisions: enabled/mode filtering, the FY derivation numbers, the
 * apply-check ladder (422 with numbers / allow path / mode-none and
 * untyped exemptions / off-day and half-day weighting / the future-FY
 * credits-only segment), the run capture's month-end anchor, and the
 * credit write's lock + audit.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const EMPLOYEE = '22222222-2222-4222-8222-222222222222';
const EARNED_ID = '33333333-3333-4333-8333-333333333331';
const SICK_ID = '33333333-3333-4333-8333-333333333332';
const COMPOFF_ID = '33333333-3333-4333-8333-333333333333';
const ADMIN = '44444444-4444-4444-8444-444444444444';

function user(id: string, role = 'employee'): RequestUser {
  return {
    userId: id,
    tenantId: TENANT,
    role,
    platformAdmin: false,
  } as unknown as RequestUser;
}

const catalogRow = (over: Record<string, unknown> = {}) => ({
  id: EARNED_ID,
  tenant_id: TENANT,
  code: 'earned',
  name: 'Earned Leave',
  accrual_mode: 'monthly',
  accrual_days: '1.00',
  carry_forward: true,
  allow_over_balance: false,
  paid: true,
  enabled: true,
  ...over,
});

const dayRow = (leave_date: string, over: Record<string, unknown> = {}) => ({
  employee_id: EMPLOYEE,
  leave_date,
  part: 'full_day',
  leave_type_id: EARNED_ID,
  ...over,
});

function build(
  opts: {
    today?: string;
    catalogRows?: Array<Record<string, unknown>>;
    creditTypeRow?: Record<string, unknown> | null;
    membershipRow?: Record<string, unknown> | null;
    dayRows?: Array<Record<string, unknown>>;
    creditRows?: Array<Record<string, unknown>>;
    memberExists?: boolean;
    memberStatus?: string;
  } = {},
) {
  const queries: { sql: string; params?: unknown[] }[] = [];
  const creditInserts: Array<Record<string, unknown>> = [];
  const tx = {
    query: jest.fn((sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes('attendance_today'))
        return Promise.resolve({
          rows: [{ today: opts.today ?? '2026-09-29' }],
        });
      if (sql.includes('attendance_lock_employee'))
        return Promise.resolve({ rows: [] });
      // readAccrualTypes (the accrual-bearing catalog) — the mock emulates
      // the SQL's own predicates: mode-bearing rows only, and enabled rows
      // only when the query asked for them.
      if (sql.includes('accrual_mode is not null')) {
        let rows = opts.catalogRows ?? [catalogRow()];
        rows = rows.filter(
          (r) => r['accrual_mode'] !== null && r['accrual_mode'] !== 'none',
        );
        if (sql.includes(' and enabled'))
          rows = rows.filter((r) => r['enabled'] === true);
        return Promise.resolve({ rows });
      }
      // The credit write's type probe (an id-scoped select).
      if (sql.includes('from public.leave_types'))
        return Promise.resolve({
          rows:
            opts.creditTypeRow === undefined
              ? [catalogRow()]
              : opts.creditTypeRow
                ? [opts.creditTypeRow]
                : [],
        });
      if (sql.includes('join_date::text as join_date'))
        return Promise.resolve({
          rows: [
            opts.membershipRow ?? { join_date: '2026-05-01', exit_date: null },
          ],
        });
      if (sql.includes('insert into public.leave_balance_credits')) {
        creditInserts.push({
          tenant_id: params?.[0],
          user_id: params?.[1],
          leave_type_id: params?.[2],
          year: params?.[3],
          days: params?.[4],
          created_by: params?.[5],
        });
        return Promise.resolve({
          rows: [{ id: 'credit-1', created_at: '2026-11-18T00:00:00Z' }],
        });
      }
      if (sql.includes('from public.leave_balance_credits'))
        return Promise.resolve({ rows: opts.creditRows ?? [] });
      if (sql.includes('d.employee_id = any($2::uuid[])')) {
        // The mock emulates the between predicate — this is what makes the
        // month-end anchor pin real: the capture call passes monthEnd as
        // the window end, so a post-period row falls outside it.
        const start = String(params?.[2]);
        const end = String(params?.[3]);
        return Promise.resolve({
          rows: (opts.dayRows ?? []).filter(
            (r) =>
              String(r['leave_date']) >= start &&
              String(r['leave_date']) <= end,
          ),
        });
      }
      if (sql.includes('weekly_off_overrides'))
        return Promise.resolve({ rows: [] });
      if (sql.includes('weekly_off_defaults'))
        return Promise.resolve({ rows: [] });
      if (sql.includes('from public.holidays'))
        return Promise.resolve({ rows: [] });
      if (sql.includes('from public.memberships') && sql.includes('count(*)'))
        return Promise.resolve({
          rows: [{ n: opts.memberExists === false ? '0' : '1' }],
        });
      // assertEmployeeNotDeactivated — the parked-access write gate reads the
      // member's status row with this exact select (leave.repository).
      if (sql.includes('select status from public.memberships'))
        return Promise.resolve({
          rows: [{ status: opts.memberStatus ?? 'active' }],
        });
      if (sql.includes('from public.attendance_enrolments'))
        return Promise.resolve({
          rows: [{ start: '2026-01-01', covers: true }],
        });
      return Promise.resolve({ rows: [] });
    }),
  } as unknown as PoolClient & { query: jest.Mock };
  const pg = {
    withTransaction: (work: (client: unknown) => Promise<unknown>) => work(tx),
  } as unknown as PgPoolFactory;
  const rpc = jest.fn().mockResolvedValue({ data: null, error: null });
  const factory = {
    createAdmin: jest.fn(() => ({ rpc })),
  } as unknown as jest.Mocked<SupabaseClientFactory>;
  const service = new LeaveBalanceService(factory, pg);
  return { service, tx, queries, rpc, creditInserts, pg, factory };
}

const rejectionOf = async (
  promise: Promise<unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> => {
  try {
    await promise;
    throw new Error('expected the promise to reject');
  } catch (err) {
    const exception = err as {
      status?: number;
      getResponse?: () => Record<string, unknown>;
    };
    return {
      status: exception.status ?? 0,
      body: exception.getResponse?.() ?? {},
    };
  }
};

describe('readBalancesFor — the derivation read', () => {
  it('returns one row per accrual-bearing type — disabled included, mode-none and remnants excluded', async () => {
    const { tx } = build({
      dayRows: [dayRow('2026-08-03', { leave_type_id: SICK_ID })],
      catalogRows: [
        catalogRow(),
        catalogRow({
          id: SICK_ID,
          code: 'sick',
          name: 'Sick Leave',
          accrual_days: '0.50',
          carry_forward: false,
          enabled: false,
        }),
        catalogRow({
          id: COMPOFF_ID,
          code: 'comp_off',
          name: 'Comp-Off',
          accrual_mode: 'none',
          carry_forward: false,
        }),
        catalogRow({
          id: 'remnant-1',
          code: null,
          name: 'Casual Leave',
          accrual_mode: null,
          enabled: false,
        }),
      ],
    });
    const rows = await readBalancesFor(tx, TENANT, EMPLOYEE);
    expect(rows.map((r) => r.code)).toEqual(['earned', 'sick']);
    expect(rows[0]).toMatchObject({
      typeId: EARNED_ID,
      accrualMode: 'monthly',
      accrualDays: 1,
      enabled: true,
      paid: true,
    });
    expect(rows[1]).toMatchObject({ enabled: false });
    // The disabled gate: sick's 0.5/mo would accrue 2.5 by the as-of — it
    // answers 0; the row stays and its consumed day still answers — that
    // visibility is exactly why disabled rows survive the read.
    expect(rows[1]).toMatchObject({
      accrualDays: 0.5,
      credits: 0,
      accrued: 0,
      carryForward: 0,
      consumed: 1,
      remaining: -1,
    });
  });

  it('derives the FY numbers: credits + as-of accrual + carry-forward - consumed', async () => {
    const { tx } = build({
      dayRows: [
        dayRow('2026-08-03'),
        dayRow('2026-08-04', { part: 'second_half' }),
      ],
      creditRows: [
        { user_id: EMPLOYEE, leave_type_id: EARNED_ID, year: 2026, days: '2' },
      ],
    });
    const rows = await readBalancesFor(tx, TENANT, EMPLOYEE);
    // Join May 2026, as-of Sep 29 2026 → 5 accrued; consumed 1.5.
    expect(rows[0]).toMatchObject({
      credits: 2,
      accrued: 5,
      carryForward: 0,
      consumed: 1.5,
      remaining: 5.5,
    });
  });

  it('a completed prior FY carries its floored unused balance', async () => {
    const { tx } = build({
      membershipRow: { join_date: '2025-06-10', exit_date: null },
      dayRows: [dayRow('2025-09-01'), dayRow('2026-08-03')],
      creditRows: [
        { user_id: EMPLOYEE, leave_type_id: EARNED_ID, year: 2025, days: '2' },
      ],
    });
    const rows = await readBalancesFor(tx, TENANT, EMPLOYEE);
    // FY2025: 10 accrued + 2 credits - 1 consumed = 11 unused → carries 11.
    expect(rows[0].carryForward).toBe(11);
    // FY2026 as-of Sep 29: Apr..Sep = 6; its credits are 0 (the 2025
    // credit belongs to that year), consumed 1.
    expect(rows[0].accrued).toBe(6);
    expect(rows[0].consumed).toBe(1);
    expect(rows[0].remaining).toBe(0 + 6 + 11 - 1);
  });

  it('a missing join row falls back through the enrolment floor (defensive chain)', async () => {
    const { tx } = build({
      membershipRow: { join_date: null, exit_date: null },
    });
    const rows = await readBalancesFor(tx, TENANT, EMPLOYEE);
    // The enrolment floor 2026-01-01 lands in FY2025: FY2025 full accrual
    // Jan..Mar = 3 → carries 3; FY2026 accrues Apr..Sep = 6.
    expect(rows[0].carryForward).toBe(3);
    expect(rows[0].accrued).toBe(6);
  });

  it('an empty catalog answers an empty list', async () => {
    const { tx } = build({ catalogRows: [] });
    const rows = await readBalancesFor(tx, TENANT, EMPLOYEE);
    expect(rows).toEqual([]);
  });
});

describe('assertBalanceForApply — the apply-time ladder', () => {
  const dates = ['2026-10-01', '2026-10-02', '2026-10-03'];
  const allWorking = new Map(
    dates.map((d) => [
      d,
      { date: d, isWorkingDay: true, kind: 'working' as const },
    ]),
  );
  const earned = {
    id: EARNED_ID,
    code: 'earned',
    name: 'Earned Leave',
    accrualMode: 'monthly' as const,
    accrualDays: 1,
    carryForward: true,
    allowOverBalance: false,
    enabled: true,
  };

  it('an apply within balance passes silently', async () => {
    const { tx } = build();
    await expect(
      assertBalanceForApply(
        tx as unknown as PoolClient,
        TENANT,
        EMPLOYEE,
        earned,
        dates,
        'full_day',
        allWorking,
        '2026-09-29',
      ),
    ).resolves.toBeUndefined();
  });

  it('an apply over balance throws 422 with both numbers in the message', async () => {
    const { tx } = build({
      dayRows: [
        dayRow('2026-08-03'),
        dayRow('2026-08-04'),
        dayRow('2026-08-05'),
        dayRow('2026-08-06'),
      ],
    });
    const { status, body } = await rejectionOf(
      assertBalanceForApply(
        tx,
        TENANT,
        EMPLOYEE,
        earned,
        dates,
        'full_day',
        allWorking,
        '2026-09-29',
      ),
    );
    expect(status).toBe(422);
    expect(body).toMatchObject({ error_code: 'LEAVE_INSUFFICIENT_BALANCE' });
    expect(String(body['message'])).toContain('1 day left');
    expect(String(body['message'])).toContain('needs 3 days');
  });

  it('a disabled type accrues nothing even in the defense gate (callers refuse first)', async () => {
    const { tx } = build();
    // The 1/mo rate would grant 5 by the as-of — the enabled gate zeroes
    // it (both callers already refuse disabled types before this runs;
    // this pins that the two derivations can never disagree).
    const { status, body } = await rejectionOf(
      assertBalanceForApply(
        tx as unknown as PoolClient,
        TENANT,
        EMPLOYEE,
        { ...earned, enabled: false },
        dates,
        'full_day',
        allWorking,
        '2026-09-29',
      ),
    );
    expect(status).toBe(422);
    expect(String(body['message'])).toContain('0 days left');
  });

  it('a type that allows over-balance never throws', async () => {
    const { tx } = build({ dayRows: [dayRow('2026-08-03')] });
    await expect(
      assertBalanceForApply(
        tx as unknown as PoolClient,
        TENANT,
        EMPLOYEE,
        { ...earned, allowOverBalance: true },
        dates,
        'full_day',
        allWorking,
        '2026-09-29',
      ),
    ).resolves.toBeUndefined();
  });

  it('mode-none is exempt — no balance reads run at all', async () => {
    const { tx, queries } = build();
    await assertBalanceForApply(
      tx,
      TENANT,
      EMPLOYEE,
      {
        id: COMPOFF_ID,
        code: 'comp_off',
        name: 'Comp-Off',
        accrualMode: 'none',
        accrualDays: 0,
        carryForward: false,
        allowOverBalance: false,
        enabled: true,
      },
      dates,
      'full_day',
      allWorking,
      '2026-09-29',
    );
    expect(
      queries.some((q) => q.sql.includes('from public.leave_balance_credits')),
    ).toBe(false);
  });

  it('a request whose dates are ALL off days runs no check (no debit to compare)', async () => {
    const { tx, queries } = build();
    const allOff = new Map(
      dates.map((d) => [
        d,
        { date: d, isWorkingDay: false, kind: 'weekly_off' as const },
      ]),
    );
    await assertBalanceForApply(
      tx,
      TENANT,
      EMPLOYEE,
      earned,
      dates,
      'full_day',
      allOff,
      '2026-09-29',
    );
    expect(
      queries.some((q) => q.sql.includes('from public.leave_balance_credits')),
    ).toBe(false);
  });

  it('a future-FY segment is checked against that FY\u2019s credits only', async () => {
    // Mar 30 2027 (FY 2026) + Apr 1 2027 (FY 2027): the FY2027 segment
    // sees credits(2027) — 5 credited → the 1-day segment fits.
    const { tx } = build({
      creditRows: [
        { user_id: EMPLOYEE, leave_type_id: EARNED_ID, year: 2027, days: '5' },
      ],
    });
    await expect(
      assertBalanceForApply(
        tx as unknown as PoolClient,
        TENANT,
        EMPLOYEE,
        earned,
        ['2027-03-30', '2027-04-01'],
        'full_day',
        new Map([
          [
            '2027-03-30',
            {
              date: '2027-03-30',
              isWorkingDay: true,
              kind: 'working' as const,
            },
          ],
          [
            '2027-04-01',
            {
              date: '2027-04-01',
              isWorkingDay: true,
              kind: 'working' as const,
            },
          ],
        ]),
        '2026-09-29',
      ),
    ).resolves.toBeUndefined();
  });

  it('a future-FY segment without credits refuses (no accrual basis exists yet)', async () => {
    const { tx } = build();
    const { status, body } = await rejectionOf(
      assertBalanceForApply(
        tx,
        TENANT,
        EMPLOYEE,
        earned,
        ['2027-03-30', '2027-04-01'],
        'full_day',
        new Map([
          [
            '2027-03-30',
            {
              date: '2027-03-30',
              isWorkingDay: true,
              kind: 'working' as const,
            },
          ],
          [
            '2027-04-01',
            {
              date: '2027-04-01',
              isWorkingDay: true,
              kind: 'working' as const,
            },
          ],
        ]),
        '2026-09-29',
      ),
    );
    // The FY2026 segment (Mar 30) passes on its own balance; the FY2027
    // segment (Apr 1) is the one that refuses.
    expect(status).toBe(422);
    expect(body).toMatchObject({ error_code: 'LEAVE_INSUFFICIENT_BALANCE' });
  });

  it('a COMPLETED prior-FY segment checks against that FY\u2019s full derivation (review patch)', async () => {
    // Today is just past April 1; the request reaches back into March —
    // inside the 7-day past window. FY2025: credits 0, consumed 8, full
    // accrual 10 (join June) → unused 2 ≥ the 2-day segment's need. The
    // old credits-only check read 0 - 8 and refused wrongly.
    const { tx } = build({
      today: '2026-04-02',
      membershipRow: { join_date: '2025-06-10', exit_date: null },
      dayRows: [
        dayRow('2025-08-03'),
        dayRow('2025-08-04'),
        dayRow('2025-08-05'),
        dayRow('2025-08-06'),
        dayRow('2025-08-07'),
        dayRow('2025-08-10'),
        dayRow('2025-08-11'),
        dayRow('2025-08-12'),
      ],
      creditRows: [
        { user_id: EMPLOYEE, leave_type_id: EARNED_ID, year: 2025, days: '0' },
      ],
    });
    await expect(
      assertBalanceForApply(
        tx as unknown as PoolClient,
        TENANT,
        EMPLOYEE,
        earned,
        ['2026-03-30', '2026-03-31'],
        'full_day',
        new Map([
          [
            '2026-03-30',
            {
              date: '2026-03-30',
              isWorkingDay: true,
              kind: 'working' as const,
            },
          ],
          [
            '2026-03-31',
            {
              date: '2026-03-31',
              isWorkingDay: true,
              kind: 'working' as const,
            },
          ],
        ]),
        '2026-04-02',
      ),
    ).resolves.toBeUndefined();
  });

  it('an over-consumed completed FY refuses a backdated segment (raw unused, not floored)', async () => {
    // Same shape, but 8 more consumed days: unused = 0 + 10 - 16 = -6 →
    // the honest (unfloored) balance refuses the 1-day backdated apply.
    const { tx } = build({
      today: '2026-04-02',
      membershipRow: { join_date: '2025-06-10', exit_date: null },
      dayRows: [
        dayRow('2025-08-03'),
        dayRow('2025-08-04'),
        dayRow('2025-08-05'),
        dayRow('2025-08-06'),
        dayRow('2025-08-07'),
        dayRow('2025-08-10'),
        dayRow('2025-08-11'),
        dayRow('2025-08-12'),
        dayRow('2025-09-01'),
        dayRow('2025-09-02'),
        dayRow('2025-09-03'),
        dayRow('2025-09-04'),
        dayRow('2025-09-07'),
        dayRow('2025-09-08'),
        dayRow('2025-09-09'),
        dayRow('2025-09-10'),
      ],
    });
    const { status, body } = await rejectionOf(
      assertBalanceForApply(
        tx,
        TENANT,
        EMPLOYEE,
        earned,
        ['2026-03-30'],
        'full_day',
        new Map([
          [
            '2026-03-30',
            {
              date: '2026-03-30',
              isWorkingDay: true,
              kind: 'working' as const,
            },
          ],
        ]),
        '2026-04-02',
      ),
    );
    expect(status).toBe(422);
    expect(body).toMatchObject({ error_code: 'LEAVE_INSUFFICIENT_BALANCE' });
  });
});

describe('captureForRun — the payslip snapshot', () => {
  it('answers per-user rows for enabled accrual types, anchored at month end', async () => {
    const other = '55555555-5555-4555-8555-555555555555';
    const { tx } = build({
      dayRows: [
        dayRow('2026-09-01'),
        // AFTER the month end — anchored out of the consumed read.
        dayRow('2026-10-02'),
        dayRow('2026-09-05', { employee_id: other }),
      ],
    });
    const captured = await captureForRun(
      tx,
      TENANT,
      new Map([
        [EMPLOYEE, { joinDate: '2026-05-01', exitDate: null }],
        [other, { joinDate: '2026-05-01', exitDate: null }],
      ]),
      '2026-09-30',
    );
    expect(captured.get(EMPLOYEE)).toEqual([
      {
        code: 'earned',
        name: 'Earned Leave',
        accrued: 5,
        availed: 1, // the Oct 2 row never debits this slip
        carryForward: 0,
        remaining: 4,
      },
    ]);
    expect(captured.get(other)?.[0].availed).toBe(1);
  });

  it('disabled and mode-none types never reach the slip', async () => {
    const { tx } = build({
      catalogRows: [
        catalogRow(),
        catalogRow({
          id: SICK_ID,
          code: 'sick',
          name: 'Sick Leave',
          enabled: false,
        }),
        catalogRow({
          id: COMPOFF_ID,
          code: 'comp_off',
          name: 'Comp-Off',
          accrual_mode: 'none',
        }),
      ],
    });
    const captured = await captureForRun(
      tx,
      TENANT,
      new Map([[EMPLOYEE, { joinDate: '2026-05-01', exitDate: null }]]),
      '2026-09-30',
    );
    expect(captured.get(EMPLOYEE)).toHaveLength(1);
    expect(captured.get(EMPLOYEE)?.[0].code).toBe('earned');
  });

  it('an empty population or catalog answers without further reads', async () => {
    const { tx, queries } = build({ catalogRows: [] });
    const captured = await captureForRun(tx, TENANT, new Map(), '2026-09-30');
    expect(captured.size).toBe(0);
    expect(queries).toHaveLength(1); // the catalog read only
  });
});

describe('applyCredit — the manual credit write', () => {
  const dtoBase = {
    userId: EMPLOYEE,
    leaveTypeId: EARNED_ID,
    year: 2026,
    days: 5,
  };

  it('inserts one manual row under the target\u2019s advisory lock and audits it', async () => {
    const { service, queries, rpc, creditInserts } = build();
    const view = await service.applyCredit(
      user(ADMIN, 'company_admin'),
      dtoBase,
    );
    expect(view).toEqual({
      id: 'credit-1',
      userId: EMPLOYEE,
      leaveTypeId: EARNED_ID,
      year: 2026,
      days: 5,
      source: 'manual',
      createdAt: '2026-11-18T00:00:00Z',
    });
    const lock = queries.find((q) =>
      q.sql.includes('attendance_lock_employee'),
    );
    expect(lock?.params?.[0]).toBe(EMPLOYEE);
    expect(creditInserts).toHaveLength(1);
    expect(creditInserts[0]).toMatchObject({
      tenant_id: TENANT,
      user_id: EMPLOYEE,
      leave_type_id: EARNED_ID,
      year: 2026,
      days: 5,
      created_by: ADMIN,
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    const call = rpc.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(call[0]).toBe('write_audit_row');
    expect(call[1].p_action).toBe('leave.credit_created');
    expect(call[1].p_target_user).toBe(EMPLOYEE);
  });

  it('a zero-day credit is refused before any transaction', async () => {
    const { service, queries } = build();
    const { status, body } = await rejectionOf(
      service.applyCredit(user(ADMIN, 'company_admin'), {
        ...dtoBase,
        days: 0,
      }),
    );
    expect(status).toBe(422);
    expect(String(body['message'])).toContain('must not be zero');
    expect(queries).toHaveLength(0);
  });

  it('a credit target with no accrual (Comp-Off) is refused 422', async () => {
    const { service, creditInserts } = build({
      creditTypeRow: catalogRow({
        id: COMPOFF_ID,
        code: 'comp_off',
        name: 'Comp-Off',
        accrual_mode: 'none',
      }),
    });
    const { status } = await rejectionOf(
      service.applyCredit(user(ADMIN, 'company_admin'), {
        ...dtoBase,
        leaveTypeId: COMPOFF_ID,
      }),
    );
    expect(status).toBe(422);
    expect(creditInserts).toHaveLength(0);
  });

  it('a foreign or unknown type answers 404 without leaking', async () => {
    const { service } = build({ creditTypeRow: null });
    const { status, body } = await rejectionOf(
      service.applyCredit(user(ADMIN, 'company_admin'), dtoBase),
    );
    expect(status).toBe(404);
    expect(body).toMatchObject({ error_code: 'RESOURCE_NOT_FOUND' });
  });

  it('a target outside this tenant answers the same 404', async () => {
    const { service } = build({ memberExists: false });
    const { status } = await rejectionOf(
      service.applyCredit(user(ADMIN, 'company_admin'), dtoBase),
    );
    expect(status).toBe(404);
  });

  it('a deactivated target answers 409 MEMBERSHIP_STATE — a parked member takes no new credit', async () => {
    const { service, creditInserts } = build({ memberStatus: 'deactivated' });
    const { status, body } = await rejectionOf(
      service.applyCredit(user(ADMIN, 'company_admin'), dtoBase),
    );
    expect(status).toBe(409);
    expect(body).toMatchObject({ error_code: 'MEMBERSHIP_STATE' });
    expect(String(body['message'])).toContain('deactivated');
    expect(creditInserts).toHaveLength(0);
  });

  it('a failed audit entry does not undo the credit', async () => {
    const { service, rpc } = build();
    rpc.mockResolvedValue({
      data: null,
      error: { code: 'PT403', message: 'x' },
    });
    await expect(
      service.applyCredit(user(ADMIN, 'company_admin'), dtoBase),
    ).resolves.toBeDefined();
  });
});
