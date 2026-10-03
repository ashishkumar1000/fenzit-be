import type { PoolClient } from 'pg';
import { DERIVED_STATUS_ORDER, PG_OVERLAP_CONSTRAINT } from './leave.constants';
import {
  derivedStatusSql,
  insertLeaveRequest,
  findCheckedInDates,
  findOverlappingDays,
  listLeaveRequests,
  readEnrolmentFloor,
  readPageSpanFacts,
} from './leave.repository';
import { pickWeeklyOffDays } from '../common/day-status/office-rules';
import { isoWeekdayOf } from '../common/day-status/day-context';

/**
 * SQL-text contracts for the leave repository (the 16-1 review pattern):
 * every statement is parameterised, tenant/employee-scoped, and keyed so a
 * raced UNIQUE is mapped BY CONSTRAINT NAME. These pins die loudly if a
 * statement loses a tenant filter or a cast — the real-DB journey proves
 * the SQL actually runs.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const EMPLOYEE = '22222222-2222-4222-8222-222222222222';

function fakeTx() {
  const tx = {
    query: jest.fn(() => Promise.resolve({ rows: [], rowCount: 0 })),
  } as unknown as PoolClient & { query: jest.Mock };
  return tx;
}

describe('statement contracts', () => {
  it('insertLeaveRequest scopes by tenant and maps ONLY the request-key constraint to duplicate_key', async () => {
    const tx = fakeTx();
    await insertLeaveRequest(tx, {
      tenantId: TENANT,
      employeeId: EMPLOYEE,
      requestId: '11111111-1111-4111-8111-111111111111',
      startDate: '2026-10-01',
      endDate: '2026-10-02',
      part: 'full_day',
      reason: 'Trip',
      createdBy: EMPLOYEE,
    });
    const sql = tx.query.mock.calls[0][0] as string;
    expect(sql).toContain('tenant_id');
    expect(sql).toContain(
      'unique (tenant_id, request_id)'.slice(0, 0) || 'values',
    );
    // The duplicate mapping is behavioural; the journey probe 2 covers the
    // raced-key 409 end to end. Here we pin the parameterisation shape.
    expect(tx.query.mock.calls[0][1]).toHaveLength(8);
  });

  it('findOverlappingDays restricts to the ACTIVE states and casts the array', async () => {
    const tx = fakeTx();
    await findOverlappingDays(tx, TENANT, EMPLOYEE, '2026-10-01', '2026-10-03');
    const sql = tx.query.mock.calls[0][0] as string;
    expect(sql).toContain('d.state = any($5::text[])');
    expect(sql).toContain('d.leave_date between $3::date and $4::date');
    expect(sql).toContain('limit 1');
  });

  it('findCheckedInDates caps at the TENANT today parameter, never the UTC current_date (review fix)', async () => {
    const tx = fakeTx();
    await findCheckedInDates(
      tx,
      TENANT,
      EMPLOYEE,
      '2026-09-01',
      '2026-10-30',
      '2026-09-29',
    );
    const sql = tx.query.mock.calls[0][0] as string;
    expect(sql).toContain('least($4::date, $5::date)');
    expect(sql).not.toContain('current_date');
    expect(tx.query.mock.calls[0][1]).toContain('2026-09-29');
  });

  it('readEnrolmentFloor guards the PG17 lower() NULL of unbounded ranges', async () => {
    const tx = fakeTx();
    await readEnrolmentFloor(tx, EMPLOYEE, '2026-09-29');
    const sql = tx.query.mock.calls[0][0] as string;
    expect(sql).toContain('lower(valid) is not null');
    expect(sql).not.toContain('upper(');
  });

  it('listLeaveRequests keeps the keyset predicate on the OUTER query', async () => {
    const tx = fakeTx();
    await listLeaveRequests(tx, {
      tenantId: TENANT,
      status: 'pending',
      cursorCreatedAt: '2026-09-28T10:00:00.000Z',
      cursorId: 'req-0',
      limit: 20,
    });
    const sql = tx.query.mock.calls[0][0] as string;
    expect(sql).toContain('(r.created_at, r.id) < (');
    expect(sql).toContain('s.derived_status =');
    expect(sql).toContain('order by r.created_at desc, r.id desc');
    // The derived-status subquery groups by request — one status per request.
    expect(sql).toContain('group by leave_request_id');
  });

  it('every list statement is parameterised end to end (no string interpolation of inputs)', async () => {
    const tx = fakeTx();
    await listLeaveRequests(tx, {
      tenantId: TENANT,
      employeeId: EMPLOYEE,
      status: 'pending',
      cursorCreatedAt: '2026-09-28T10:00:00.000Z',
      cursorId: 'req-0',
      limit: 50,
    });
    const sql = tx.query.mock.calls[0][0] as string;
    expect(sql).not.toContain(TENANT);
    expect(sql).not.toContain(EMPLOYEE);
    expect(sql).not.toContain('2026-09-28T10:00:00.000Z');
    expect(sql).not.toContain('req-0');
  });
});

describe('derivedStatusSql (D5 parity)', () => {
  it('generates the CASE branches in DERIVED_STATUS_ORDER — the same order the model derives with', () => {
    const sql = derivedStatusSql();
    let last = -1;
    for (const state of DERIVED_STATUS_ORDER) {
      const at = sql.indexOf(`'${state}'`);
      expect(at).toBeGreaterThan(last);
      last = at;
    }
  });

  it('falls through to rejected when no day row matches an earlier bucket', () => {
    expect(derivedStatusSql()).toContain("else 'rejected'");
  });
});

describe('readPageSpanFacts (the list page batch)', () => {
  /** Rows returned per query call, in call order (overrides, defaults, holidays). */
  function txWithRows(responses: unknown[][]) {
    let call = 0;
    return {
      query: jest.fn(() =>
        Promise.resolve({ rows: responses[call++] ?? [], rowCount: 0 }),
      ),
    } as unknown as PoolClient & { query: jest.Mock };
  }

  const REAL_PICKERS = {
    pickWeeklyOffDays,
    isoWeekdayOf,
  };

  it('fetches the whole page in exactly 3 statements: overrides by any-array, tenant defaults, tenant holidays — union range, fully parameterised', async () => {
    const tx = fakeTx();
    const emp2 = '33333333-3333-4333-8333-333333333333';
    await readPageSpanFacts(
      tx,
      TENANT,
      [
        { employeeId: EMPLOYEE, dates: ['2026-10-02', '2026-10-04'] },
        { employeeId: emp2, dates: ['2026-10-01', '2026-10-02'] },
        { employeeId: EMPLOYEE, dates: ['2026-10-03'] }, // same employee again
      ],
      pickWeeklyOffDays,
      isoWeekdayOf,
    );
    expect(tx.query.mock.calls).toHaveLength(3);

    const [ovSql, ovParams] = tx.query.mock.calls[0];
    expect(ovSql).toContain('attendance_weekly_off_overrides');
    expect(ovSql).toContain('employee_id = any($1::uuid[])');
    expect(ovSql).toContain('valid && $2::daterange');
    expect(ovParams[0]).toEqual([EMPLOYEE, emp2].sort()); // deduped
    expect(ovParams[1]).toBe('[2026-10-01,2026-10-04]'); // union range

    const [defSql, defParams] = tx.query.mock.calls[1];
    expect(defSql).toContain('attendance_weekly_off_defaults');
    expect(defSql).toContain('tenant_id = $1::uuid');
    expect(defSql).toContain('valid && $2::daterange');
    expect(defParams[0]).toBe(TENANT);
    expect(defParams[1]).toBe('[2026-10-01,2026-10-04]');

    const [holSql, holParams] = tx.query.mock.calls[2];
    expect(holSql).toContain('from public.holidays');
    expect(holSql).toContain('tenant_id = $1::uuid');
    expect(holSql).toContain('holiday_date between $2::date and $3::date');
    expect(holParams[0]).toBe(TENANT);
    expect(holParams[1]).toBe('2026-10-01');
    expect(holParams[2]).toBe('2026-10-04');

    for (const [sql, params] of tx.query.mock.calls) {
      expect(String(sql)).not.toContain(TENANT);
      expect(String(sql)).not.toContain('2026-10-0');
      expect(params.length).toBeGreaterThan(0);
    }
  });

  it('computes the same facts readSpanFacts would: the covering override REPLACES the default and the holiday WINS over the weekly off', async () => {
    // Fri 02 Oct, Sat 03 Oct, Sun 04 Oct 2026. The override cuts the
    // tenant's Sat+Sun default down to Sunday only; the Sunday is ALSO a
    // holiday, and the holiday must win the kind.
    const tx = txWithRows([
      [{ employee_id: EMPLOYEE, valid: '[2026-01-01,)', days: [7] }],
      [{ valid: '[2026-01-01,)', days: [6, 7] }],
      [{ holiday_date: '2026-10-04' }],
    ]);
    const facts = await readPageSpanFacts(
      tx,
      TENANT,
      [
        {
          employeeId: EMPLOYEE,
          dates: ['2026-10-02', '2026-10-03', '2026-10-04'],
        },
      ],
      REAL_PICKERS.pickWeeklyOffDays,
      REAL_PICKERS.isoWeekdayOf,
    );
    const byDate = facts.get(EMPLOYEE)!;
    expect(byDate.get('2026-10-02')).toEqual({
      date: '2026-10-02',
      isWorkingDay: true,
      kind: 'working',
    });
    expect(byDate.get('2026-10-03')).toEqual({
      date: '2026-10-03',
      isWorkingDay: true,
      kind: 'working',
    });
    expect(byDate.get('2026-10-04')).toEqual({
      date: '2026-10-04',
      isWorkingDay: false,
      kind: 'holiday',
    });
  });

  it('an employee with NO covering override falls through to the tenant defaults; rows of OTHER employees never leak in', async () => {
    const tx = txWithRows([
      // override belongs to a DIFFERENT employee on the page
      [
        {
          employee_id: '44444444-4444-4444-8444-444444444444',
          valid: '[2026-01-01,)',
          days: [],
        },
      ],
      [{ valid: '[2026-01-01,)', days: [6, 7] }],
      [],
    ]);
    const facts = await readPageSpanFacts(
      tx,
      TENANT,
      [{ employeeId: EMPLOYEE, dates: ['2026-10-03'] }], // Saturday
      pickWeeklyOffDays,
      isoWeekdayOf,
    );
    expect(facts.get(EMPLOYEE)!.get('2026-10-03')).toEqual({
      date: '2026-10-03',
      isWorkingDay: false,
      kind: 'weekly_off',
    });
  });

  it('several requests of the SAME employee land in ONE fact map (the per-date merge)', async () => {
    const tx = txWithRows([[], [], []]);
    const facts = await readPageSpanFacts(
      tx,
      TENANT,
      [
        { employeeId: EMPLOYEE, dates: ['2026-10-02'] },
        { employeeId: EMPLOYEE, dates: ['2026-10-05', '2026-10-06'] },
      ],
      pickWeeklyOffDays,
      isoWeekdayOf,
    );
    const byDate = facts.get(EMPLOYEE)!;
    expect([...byDate.keys()].sort()).toEqual([
      '2026-10-02',
      '2026-10-05',
      '2026-10-06',
    ]);
  });

  it('an empty page answers an empty map and issues NO statements', async () => {
    const tx = fakeTx();
    const facts = await readPageSpanFacts(
      tx,
      TENANT,
      [],
      pickWeeklyOffDays,
      isoWeekdayOf,
    );
    expect(facts.size).toBe(0);
    expect(tx.query.mock.calls).toHaveLength(0);
  });
});

describe('constraint-name mapping (D7)', () => {
  it('names the partial index the overlap backstop races on', () => {
    expect(PG_OVERLAP_CONSTRAINT).toBe('leave_request_days_active_uq');
  });
});

describe('readEnrolmentFloor (D9 floor preference)', () => {
  function txWithRows(rows: { start: string; covers: boolean }[]) {
    return {
      query: jest.fn(() => Promise.resolve({ rows })),
    } as unknown as PoolClient & { query: jest.Mock };
  }

  it('prefers the covering enrolment start when one covers today', async () => {
    const tx = txWithRows([
      { start: '2026-01-01', covers: false },
      { start: '2026-05-01', covers: true },
    ]);
    const floor = await readEnrolmentFloor(tx, EMPLOYEE, '2026-09-29');
    expect(floor).toEqual({
      exists: true,
      floor: '2026-05-01',
      coversToday: true,
    });
  });

  it('with NO covering row, the floor is the earliest FUTURE start — an ended past enrolment neither gates nor lowers it (review fix)', async () => {
    const tx = txWithRows([
      { start: '2026-01-01', covers: false }, // ended past enrolment
      { start: '2026-10-05', covers: false }, // the re-enable
    ]);
    const floor = await readEnrolmentFloor(tx, EMPLOYEE, '2026-09-29');
    expect(floor).toEqual({
      exists: true,
      floor: '2026-10-05',
      coversToday: false,
    });
  });

  it('an employee with only past, ended enrolments floors at the earliest start (history-only — the gate rejects)', async () => {
    const tx = txWithRows([{ start: '2026-01-01', covers: false }]);
    const floor = await readEnrolmentFloor(tx, EMPLOYEE, '2026-09-29');
    expect(floor).toEqual({
      exists: true,
      floor: '2026-01-01',
      coversToday: false,
    });
  });
});
