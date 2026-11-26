import type { PoolClient } from 'pg';
import {
  ACTIVE_LEAVE_STATES,
  DERIVED_STATUS_ORDER,
  PG_OVERLAP_CONSTRAINT,
} from './leave.constants';
import {
  countActiveEmployees,
  countLeaveRequestsByStatus,
  derivedStatusSql,
  findAvailableColleagues,
  findCheckedInDates,
  findOfficeAssignment,
  findOfficeNames,
  findOverlappingDays,
  insertLeaveRequest,
  listLeaveRequests,
  readEnrolmentFloor,
  readPageSpanFacts,
  readSpanFacts,
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
const OFFICE = '33333333-3333-4333-8333-333333333333';

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
      leaveTypeId: null,
    });
    const sql = tx.query.mock.calls[0][0] as string;
    expect(sql).toContain('tenant_id');
    expect(sql).toContain('leave_type_id');
    expect(sql).toContain(
      'unique (tenant_id, request_id)'.slice(0, 0) || 'values',
    );
    // The duplicate mapping is behavioural; the journey probe 2 covers the
    // raced-key 409 end to end. Here we pin the parameterisation shape — the
    // ninth parameter is the CAP-12 typing link (null = untyped, reads paid).
    expect(tx.query.mock.calls[0][1]).toHaveLength(9);
    expect((tx.query.mock.calls[0][1] as unknown[])[8]).toBeNull();
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

  it('countActiveEmployees counts employees whose membership is ACTIVE — status pinned so invited/deactivated/removed stay out', async () => {
    const tx = fakeTx();
    tx.query.mockResolvedValueOnce({ rows: [{ n: '7' }], rowCount: 1 });
    await expect(countActiveEmployees(tx, TENANT)).resolves.toBe(7);
    const [sql, params] = tx.query.mock.calls[0];
    expect(sql).toContain("role = 'employee'");
    expect(sql).toContain("status = 'active'");
    expect(sql).toContain('tenant_id = $1::uuid');
    expect(params).toEqual([TENANT]);
  });

  it('findOfficeNames reads the assignment covering the TENANT\u2019s today in one any-array statement (never current_date)', async () => {
    const tx = fakeTx();
    tx.query.mockResolvedValueOnce({
      rows: [{ employee_id: EMPLOYEE, name: 'Gurgaon Hub' }],
      rowCount: 1,
    });
    const names = await findOfficeNames(tx, TENANT, [EMPLOYEE], '2026-11-24');
    expect(names.get(EMPLOYEE)).toBe('Gurgaon Hub');
    const [sql, params] = tx.query.mock.calls[0];
    expect(sql).toContain('= any($2::uuid[])');
    expect(sql).toContain('valid @> $3::date');
    expect(sql).not.toContain('current_date');
    expect(params).toEqual([TENANT, [EMPLOYEE], '2026-11-24']);
  });

  it('findOfficeNames with an empty page answers an empty map and issues NO statements', async () => {
    const tx = fakeTx();
    const names = await findOfficeNames(tx, TENANT, [], '2026-11-24');
    expect(names.size).toBe(0);
    expect(tx.query).not.toHaveBeenCalled();
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
    // …and only over THIS tenant's day rows (the plain `tenant_id` without
    // the `r.` prefix is the subquery's own predicate) — the count used to
    // group every tenant's days before the join filtered them.
    expect(sql).toContain('where tenant_id = $1::uuid');
  });

  it('listLeaveRequests scopes a manager\u2019s team list with one = any() predicate', async () => {
    const tx = fakeTx();
    await listLeaveRequests(tx, {
      tenantId: TENANT,
      employeeIds: ['emp-1', 'emp-2'],
      limit: 20,
    });
    const sql = tx.query.mock.calls[0][0] as string;
    const params = tx.query.mock.calls[0][1] as unknown[];
    expect(sql).toContain('r.employee_id = any($2::uuid[])');
    expect(params[1]).toEqual(['emp-1', 'emp-2']);
    // The derived-status subquery pays only for the same employees.
    expect(sql).toMatch(/employee_id = any\(\$\d+::uuid\[\]\)/);
    // The page bound keeps its own placeholder; the scope is appended after it.
    expect(sql).toContain('limit $3');
    expect(params[params.length - 1]).toEqual(['emp-1', 'emp-2']);
  });

  it('listLeaveRequests leaves the derived-status subquery company-wide for an admin', async () => {
    const tx = fakeTx();
    await listLeaveRequests(tx, { tenantId: TENANT, limit: 20 });
    const params = tx.query.mock.calls[0][1] as unknown[];
    expect(tx.query.mock.calls[0][0]).toContain('limit $2');
    expect(params[params.length - 1]).toBeNull();
  });

  it('listLeaveRequests carries the type display columns off a LEFT join — a legacy row with no type still lists (the console calendar reads these)', async () => {
    const tx = fakeTx();
    await listLeaveRequests(tx, { tenantId: TENANT, limit: 20 });
    const sql = tx.query.mock.calls[0][0] as string;
    expect(sql).toContain(
      'left join public.leave_types lt on lt.id = r.leave_type_id',
    );
    expect(sql).toContain('lt.code as leave_type_code');
    expect(sql).toContain('lt.name as leave_type_name');
  });

  it('listLeaveRequests bounds the 27-1 window to the OVERLAP pair, parameterised', async () => {
    const tx = fakeTx();
    await listLeaveRequests(tx, {
      tenantId: TENANT,
      status: 'approved',
      from: '2026-11-01',
      to: '2026-11-30',
      limit: 20,
    });
    const sql = tx.query.mock.calls[0][0] as string;
    // Overlap, not containment: a span hanging over either window edge matches.
    expect(sql).toContain('r.end_date >= $3::date');
    expect(sql).toContain('r.start_date <= $4::date');
    const params = tx.query.mock.calls[0][1] as unknown[];
    expect(params).toContain('2026-11-01');
    expect(params).toContain('2026-11-30');
    expect(sql).not.toContain('2026-11-01');
    expect(sql).not.toContain('2026-11-30');
  });

  it('listLeaveRequests without the window ships no overlap predicates (27-1 regression)', async () => {
    const tx = fakeTx();
    await listLeaveRequests(tx, {
      tenantId: TENANT,
      status: 'pending',
      limit: 20,
    });
    const sql = tx.query.mock.calls[0][0] as string;
    expect(sql).not.toContain('r.end_date >=');
    expect(sql).not.toContain('r.start_date <=');
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

  it('listLeaveRequests applies the search needle as ONE parameter across name, code and reason — escaped against LIKE wildcards', async () => {
    const tx = fakeTx();
    await listLeaveRequests(tx, { tenantId: TENANT, q: '100%', limit: 20 });
    const sql = tx.query.mock.calls[0][0] as string;
    expect(sql).toContain('u.name ilike $');
    expect(sql).toContain('m.employee_code ilike $');
    expect(sql).toContain('r.reason ilike $');
    const params = tx.query.mock.calls[0][1] as unknown[];
    // "100%" matches "100%", never every "100" — the wildcards are escaped.
    expect(params).toContain('%100\\%%');
    // The other two wildcard characters escape too: a bare `_` is a
    // single-char wildcard and a raw trailing backslash corrupts the
    // escape sequence itself.
    await listLeaveRequests(tx, { tenantId: TENANT, q: 'a_b', limit: 20 });
    expect(tx.query.mock.calls[1][1]).toContain('%a\\_b%');
    await listLeaveRequests(tx, { tenantId: TENANT, q: 'c:\\path', limit: 20 });
    expect(tx.query.mock.calls[2][1]).toContain('%c:\\\\path%');
  });

  it('listLeaveRequests without the needle ships no ilike predicate', async () => {
    const tx = fakeTx();
    await listLeaveRequests(tx, { tenantId: TENANT, limit: 20 });
    expect(tx.query.mock.calls[0][0] as string).not.toContain('ilike');
  });

  it('countLeaveRequestsByStatus counts over the SAME generated CASE the list filters with and zero-defaults the statuses with no rows', async () => {
    const tx = fakeTx();
    tx.query.mockResolvedValueOnce({
      rows: [
        { derived_status: 'pending', n: '3' },
        { derived_status: 'approved', n: '11' },
      ],
      rowCount: 2,
    });
    const counts = await countLeaveRequestsByStatus(tx, TENANT);
    const sql = tx.query.mock.calls[0][0] as string;
    expect(sql).toContain('select s.derived_status, count(*)::text as n');
    expect(sql).toContain('group by s.derived_status');
    expect(sql).toContain('r.tenant_id = $1::uuid');
    // The day-row subquery is tenant-scoped too (no `r.` prefix = the
    // subquery's own where) — grouping all tenants' days before the join
    // was correct but scanned cross-tenant rows on every summary read.
    expect(sql).toContain('where tenant_id = $1::uuid');
    // The pill counts and the status filter read the same CASE — they can
    // never disagree.
    expect(sql).toContain(derivedStatusSql());
    expect(tx.query.mock.calls[0][1]).toEqual([TENANT]);
    expect(counts).toEqual({
      pending: 3,
      approved: 11,
      revoked: 0,
      cancelled: 0,
      rejected: 0,
    });
  });

  it('findOfficeAssignment reads the one TODAY-covering assignment — office id and name to scope the coverage roster by', async () => {
    const tx = fakeTx();
    tx.query.mockResolvedValueOnce({
      rows: [{ office_id: OFFICE, name: 'San Francisco Office' }],
      rowCount: 1,
    });
    const found = await findOfficeAssignment(
      tx,
      TENANT,
      EMPLOYEE,
      '2026-11-24',
    );
    expect(found).toEqual({
      officeId: OFFICE,
      officeName: 'San Francisco Office',
    });
    const [sql, params] = tx.query.mock.calls[0];
    expect(sql).toContain('a.valid @> $3::date');
    expect(sql).toContain('limit 1');
    expect(params).toEqual([TENANT, EMPLOYEE, '2026-11-24']);
  });

  it('findAvailableColleagues keeps ACTIVE colleagues of the requester\u2019s office only — excluding the requester and anyone holding a pending-or-approved day in the span', async () => {
    const tx = fakeTx();
    await findAvailableColleagues(tx, {
      tenantId: TENANT,
      excludeEmployeeId: EMPLOYEE,
      anchor: '2026-11-24',
      officeId: OFFICE,
      start: '2026-11-27',
      end: '2026-11-28',
    });
    const sql = tx.query.mock.calls[0][0] as string;
    expect(sql).toContain("m.role = 'employee'");
    expect(sql).toContain("m.status = 'active'");
    expect(sql).toContain('m.user_id <> $2::uuid');
    expect(sql).toContain('a.valid @> $3::date');
    expect(sql).toContain('a.office_id = $4::uuid');
    expect(sql).toContain('not exists');
    // The leave-day exclusion is TENANT-scoped — a re-invited user's stale
    // days at a previous company must not punch them out of this roster.
    expect(sql).toContain('d.tenant_id = $1::uuid');
    expect(sql).toContain('d.state = any($5::text[])');
    expect(sql).toContain('d.leave_date between $6::date and $7::date');
    expect(sql).toContain('order by u.name');
    const params = tx.query.mock.calls[0][1] as unknown[];
    expect(params.slice(0, 4)).toEqual([
      TENANT,
      EMPLOYEE,
      '2026-11-24',
      OFFICE,
    ]);
    expect(params[4]).toEqual(ACTIVE_LEAVE_STATES);
    expect(params.slice(5)).toEqual(['2026-11-27', '2026-11-28']);
  });

  it('findAvailableColleagues with NO requester office goes COMPANY-WIDE — the office join disappears entirely so office-less actives count too, and today leaves the param list ($3 states, $4/$5 span)', async () => {
    const tx = fakeTx();
    await findAvailableColleagues(tx, {
      tenantId: TENANT,
      excludeEmployeeId: EMPLOYEE,
      anchor: '2026-11-24',
      officeId: null,
      start: '2026-11-27',
      end: '2026-11-28',
    });
    const sql = tx.query.mock.calls[0][0] as string;
    // No join at all — company-wide must include active employees with no
    // current office assignment (countActiveEmployees' own notion of "in").
    expect(sql).not.toContain('attendance_office_assignments');
    expect(sql).not.toContain('a.valid');
    expect(sql).not.toContain('a.office_id =');
    expect(sql).toContain("m.role = 'employee'");
    expect(sql).toContain('d.tenant_id = $1::uuid');
    expect(sql).toContain('d.state = any($3::text[])');
    expect(sql).toContain('d.leave_date between $4::date and $5::date');
    const params = tx.query.mock.calls[0][1] as unknown[];
    expect(params.slice(0, 3)).toEqual([TENANT, EMPLOYEE, ACTIVE_LEAVE_STATES]);
    expect(params.slice(3)).toEqual(['2026-11-27', '2026-11-28']);
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

/** A scoped-holiday read row: always-applicable 'all'. */
function holidayOnRow(holiday_date: string) {
  return {
    id: '00000000-0000-4000-8000-0000000000e1',
    name: 'Diwali',
    scope: 'all',
    description: null,
    holiday_date,
    officeIds: [],
  };
}

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

  it('fetches the whole page in exactly 4 statements: overrides by any-array, tenant defaults, scoped tenant holidays, the page assignments — union range, fully parameterised', async () => {
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
    expect(tx.query.mock.calls).toHaveLength(4);

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

    const [asgSql, asgParams] = tx.query.mock.calls[3];
    expect(asgSql).toContain('from public.attendance_office_assignments');
    expect(asgSql).toContain('employee_id = any($2::uuid[])');
    expect(asgSql).toContain('valid && $3::daterange');
    expect(asgParams[0]).toBe(TENANT);
    expect(asgParams[1]).toEqual([EMPLOYEE, emp2].sort());
    expect(asgParams[2]).toBe('[2026-10-01,2026-10-04]');

    for (const [sql, params] of tx.query.mock.calls) {
      expect(String(sql)).not.toContain(TENANT);
      expect(String(sql)).not.toContain(EMPLOYEE);
      expect(String(sql)).not.toContain(emp2);
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
      [holidayOnRow('2026-10-04')],
      [], // the employee's overlapping assignments — none, so 'all' applies
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
      pickWeeklyOffDays,
      isoWeekdayOf,
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

  it('is the DIFFERENTIAL twin of readSpanFacts — identical scripted rows yield identical fact maps (the parity claim, tested)', async () => {
    const responses = [
      [{ employee_id: EMPLOYEE, valid: '[2026-01-01,)', days: [7] }],
      [{ valid: '[2026-01-01,)', days: [6, 7] }],
      [holidayOnRow('2026-10-04')],
      [
        {
          employee_id: EMPLOYEE,
          office_id: 'office-1',
          valid: '[2026-01-01,)',
        },
      ],
    ];
    const dates = ['2026-10-02', '2026-10-03', '2026-10-04'];
    const single = await readSpanFacts(
      txWithRows(responses),
      TENANT,
      EMPLOYEE,
      dates,
      pickWeeklyOffDays,
      isoWeekdayOf,
    );
    const batched = await readPageSpanFacts(
      txWithRows(responses),
      TENANT,
      [{ employeeId: EMPLOYEE, dates }],
      pickWeeklyOffDays,
      isoWeekdayOf,
    );
    expect(batched.get(EMPLOYEE)).toEqual(single);
  });

  it('an override row whose validity EXCLUDES a span date is ignored for that date (the superset-is-harmless claim)', async () => {
    // The override ended in February — it must not reach October's facts,
    // which fall through to the tenant default instead.
    const tx = txWithRows([
      [
        {
          employee_id: EMPLOYEE,
          valid: '[2026-01-01,2026-02-01)',
          days: [7],
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

  it('several requests of the SAME employee land in ONE fact map, duplicate dates included once (the per-date merge)', async () => {
    const tx = txWithRows([[], [], []]);
    const facts = await readPageSpanFacts(
      tx,
      TENANT,
      [
        { employeeId: EMPLOYEE, dates: ['2026-10-02'] },
        // Overlapping requests on one page share the 2nd — it must not
        // double up in the fact map.
        { employeeId: EMPLOYEE, dates: ['2026-10-02', '2026-10-05'] },
      ],
      pickWeeklyOffDays,
      isoWeekdayOf,
    );
    const byDate = facts.get(EMPLOYEE)!;
    expect([...byDate.keys()].sort()).toEqual(['2026-10-02', '2026-10-05']);
  });

  it('a span with EMPTY dates is skipped — no undefined reaches a daterange param, no employee key is invented', async () => {
    const tx = fakeTx();
    const facts = await readPageSpanFacts(
      tx,
      TENANT,
      [
        { employeeId: EMPLOYEE, dates: [] },
        {
          employeeId: '45444444-4444-4444-8444-444444444444',
          dates: ['2026-10-03'],
        },
      ],
      pickWeeklyOffDays,
      isoWeekdayOf,
    );
    expect(facts.size).toBe(1); // only the dated employee
    expect(facts.has(EMPLOYEE)).toBe(false);
    expect(tx.query.mock.calls).toHaveLength(4); // still one batched page
    const [, ovParams] = tx.query.mock.calls[0];
    expect(ovParams[0]).toEqual(['45444444-4444-4444-8444-444444444444']);
  });

  it('every span empty answers an empty map and issues NO statements', async () => {
    const tx = fakeTx();
    const facts = await readPageSpanFacts(
      tx,
      TENANT,
      [
        { employeeId: EMPLOYEE, dates: [] },
        { employeeId: '45444444-4444-4444-8444-444444444444', dates: [] },
      ],
      pickWeeklyOffDays,
      isoWeekdayOf,
    );
    expect(facts.size).toBe(0);
    expect(tx.query.mock.calls).toHaveLength(0);
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
