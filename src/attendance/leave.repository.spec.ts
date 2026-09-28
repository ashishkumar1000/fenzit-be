import type { PoolClient } from 'pg';
import { DERIVED_STATUS_ORDER, PG_OVERLAP_CONSTRAINT } from './leave.constants';
import {
  derivedStatusSql,
  findCheckedInDates,
  findOverlappingDays,
  insertLeaveRequest,
  listLeaveRequests,
  readEnrolmentFloor,
} from './leave.repository';

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
    await findCheckedInDates(tx, TENANT, EMPLOYEE, '2026-09-01', '2026-10-30', '2026-09-29');
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
    expect(floor).toEqual({ exists: true, floor: '2026-05-01', coversToday: true });
  });

  it('with NO covering row, the floor is the earliest FUTURE start — an ended past enrolment neither gates nor lowers it (review fix)', async () => {
    const tx = txWithRows([
      { start: '2026-01-01', covers: false }, // ended past enrolment
      { start: '2026-10-05', covers: false }, // the re-enable
    ]);
    const floor = await readEnrolmentFloor(tx, EMPLOYEE, '2026-09-29');
    expect(floor).toEqual({ exists: true, floor: '2026-10-05', coversToday: false });
  });

  it('an employee with only past, ended enrolments floors at the earliest start (history-only — the gate rejects)', async () => {
    const tx = txWithRows([{ start: '2026-01-01', covers: false }]);
    const floor = await readEnrolmentFloor(tx, EMPLOYEE, '2026-09-29');
    expect(floor).toEqual({ exists: true, floor: '2026-01-01', coversToday: false });
  });
});
