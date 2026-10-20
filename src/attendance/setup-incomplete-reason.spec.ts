import { SupabaseClient } from '@supabase/supabase-js';
import {
  invitedTrackedEmployeeReason,
  setupIncompleteMessage,
} from './setup-incomplete-reason';
import { istTodayIso } from '../reports/registry/report-params.util';

const TENANT = 'tenant-A';
const ANN = '11111111-1111-1111-1111-111111111111';
const BEN = '22222222-2222-2222-2222-222222222222';
const CAL = '33333333-3333-3333-3333-333333333333';
const TODAY = istTodayIso();
const COVERS_TODAY = `[${TODAY},${TODAY}]`;

type Result = { data: unknown; error: unknown };

/**
 * A stand-in for the database. Each table answers with its own rows; every
 * chain method is recorded so a test can prove the tenant and today filters.
 */
function fakeAdmin(tables: Record<string, Result>) {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
  const from = jest.fn((table: string) => {
    const result = tables[table] ?? { data: [], error: null };
    const qb: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'neq', 'in', 'order', 'filter']) {
      qb[m] = jest.fn((...args: unknown[]) => {
        calls.push({ table, method: m, args });
        return qb;
      });
    }
    qb['then'] = (resolve: (v: unknown) => void) => resolve(result);
    return qb;
  });
  return { admin: { from } as unknown as SupabaseClient, calls };
}

const rows = (ids: string[]): Result => ({
  data: ids.map((employee_id) => ({ employee_id })),
  error: null,
});

const member = (userId: string, status: string, name: string | null, code = 'EMP-002') => ({
  user_id: userId,
  role: 'employee',
  status,
  employee_code: code,
  created_at: '2026-10-20T00:00:00Z',
  users: { name, country_code: '+91', phone_number: '1212121212', disabled: false },
});
const members = (...list: ReturnType<typeof member>[]): Result => ({ data: list, error: null });

/** Enrolled and assigned for today, the state the database gate looks at. */
const readyTables = (memberRows: Result): Record<string, Result> => ({
  attendance_enrolments: rows([ANN, BEN, CAL]),
  attendance_office_assignments: rows([ANN, BEN, CAL]),
  memberships: memberRows,
});

describe('invitedTrackedEmployeeReason', () => {
  it('names one invited employee who is enrolled and assigned for today', async () => {
    const { admin } = fakeAdmin(readyTables(members(member(ANN, 'invited', 'Suresh'))));
    await expect(invitedTrackedEmployeeReason(admin, TENANT)).resolves.toBe(
      'Suresh has not signed in to the app yet. Tracking can start after their first sign-in.',
    );
  });

  it('names every waiting employee, so fixing one does not reveal another', async () => {
    const { admin } = fakeAdmin(
      readyTables(
        members(member(ANN, 'invited', 'Suresh'), member(BEN, 'invited', 'Ravi'), member(CAL, 'invited', 'Meena')),
      ),
    );
    await expect(invitedTrackedEmployeeReason(admin, TENANT)).resolves.toBe(
      'Suresh, Ravi and Meena have not signed in to the app yet. Tracking can start after their first sign-in.',
    );
  });

  it('uses the singular verb for two names only when there is one', async () => {
    const { admin } = fakeAdmin(
      readyTables(members(member(ANN, 'invited', 'Suresh'), member(BEN, 'invited', 'Ravi'))),
    );
    await expect(invitedTrackedEmployeeReason(admin, TENANT)).resolves.toMatch(
      /^Suresh and Ravi have not signed in/,
    );
  });

  it('does not name an invited employee who has no office assignment, because that is a different fix', async () => {
    const { admin } = fakeAdmin({
      attendance_enrolments: rows([ANN]),
      attendance_office_assignments: rows([]),
      memberships: members(member(ANN, 'invited', 'Suresh')),
    });
    await expect(invitedTrackedEmployeeReason(admin, TENANT)).resolves.toBeNull();
  });

  it('does not name an invited employee who is not enrolled to track', async () => {
    const { admin } = fakeAdmin({
      attendance_enrolments: rows([]),
      attendance_office_assignments: rows([ANN]),
      memberships: members(member(ANN, 'invited', 'Suresh')),
    });
    await expect(invitedTrackedEmployeeReason(admin, TENANT)).resolves.toBeNull();
  });

  it('gives no reason when every enrolled and assigned employee is already active', async () => {
    const { admin } = fakeAdmin(readyTables(members(member(ANN, 'active', 'Suresh'))));
    await expect(invitedTrackedEmployeeReason(admin, TENANT)).resolves.toBeNull();
  });

  it('never names a removed membership, even if one were returned', async () => {
    const { admin } = fakeAdmin(readyTables(members(member(ANN, 'removed', 'Former'))));
    await expect(invitedTrackedEmployeeReason(admin, TENANT)).resolves.toBeNull();
  });

  it('uses the employee code when there is no name, so the owner can still tell who it is', async () => {
    const { admin } = fakeAdmin(readyTables(members(member(ANN, 'invited', null, 'EMP-007'))));
    await expect(invitedTrackedEmployeeReason(admin, TENANT)).resolves.toMatch(
      /^Employee EMP-007 has not signed in/,
    );
  });

  it('cleans a long or multi-line name: one line, capped at 80 characters', async () => {
    const messy = `  Ravi\n\n   ${'K'.repeat(120)}  `;
    const { admin } = fakeAdmin(readyTables(members(member(ANN, 'invited', messy))));
    const text = await invitedTrackedEmployeeReason(admin, TENANT);
    const name = (text ?? '').replace(' has not signed in to the app yet. Tracking can start after their first sign-in.', '');
    expect(name).toBe(`Ravi ${'K'.repeat(75)}`);
    expect(name).not.toContain('\n');
  });

  it('reads only the named company and only rows that cover today', async () => {
    const { admin, calls } = fakeAdmin(readyTables(members()));
    await invitedTrackedEmployeeReason(admin, TENANT);
    const scoped = calls.filter((c) => c.method === 'eq' && c.args[0] === 'tenant_id');
    expect(scoped.map((c) => c.table).sort()).toEqual([
      'attendance_enrolments',
      'attendance_office_assignments',
      'memberships',
    ]);
    expect(scoped.every((c) => c.args[1] === TENANT)).toBe(true);
    const today = calls.filter((c) => c.method === 'filter');
    expect(today).toHaveLength(2);
    expect(today.every((c) => c.args[0] === 'valid' && c.args[1] === 'ov' && c.args[2] === COVERS_TODAY)).toBe(true);
  });

  it('never throws: a failed read gives no reason, so the database text still explains the refusal', async () => {
    const { admin } = fakeAdmin({
      ...readyTables(members(member(ANN, 'invited', 'Suresh'))),
      attendance_enrolments: { data: null, error: { message: 'boom' } },
    });
    await expect(invitedTrackedEmployeeReason(admin, TENANT)).resolves.toBeNull();
  });
});

describe('setupIncompleteMessage — the exact reason the owner sees', () => {
  const NO_OFFICE = {
    message: 'attendance setup could not be completed: no office has been added yet. Add an office, then try again.',
    details: `tenant ${TENANT} has no active office`,
  };
  const NO_EMPLOYEE = {
    message:
      'attendance setup could not be completed: no employee is enrolled for today with a live office assignment. Enrol an employee and assign them to an office, then try again.',
    details: `tenant ${TENANT} has no tracked employee with an office assignment`,
  };
  const NO_RULE = {
    message:
      'attendance setup could not be completed: office «Bhopal» has no timing rule covering today. Add a rule for this office, then try again.',
    details: `tenant ${TENANT} has an active office without a rule`,
  };

  it('names the invited employee when that is why no one can be tracked', async () => {
    const { admin } = fakeAdmin(readyTables(members(member(ANN, 'invited', 'Suresh'))));
    await expect(setupIncompleteMessage(admin, TENANT, NO_EMPLOYEE)).resolves.toBe(
      'Suresh has not signed in to the app yet. Tracking can start after their first sign-in.',
    );
  });

  it('sends the database reason for the no-office gate, lead-in removed and first letter capitalised', async () => {
    const { admin } = fakeAdmin({});
    await expect(setupIncompleteMessage(admin, TENANT, NO_OFFICE)).resolves.toBe(
      'No office has been added yet. Add an office, then try again.',
    );
  });

  it('sends the database reason for the no-rule gate, keeping the office name exactly', async () => {
    const { admin } = fakeAdmin({});
    await expect(setupIncompleteMessage(admin, TENANT, NO_RULE)).resolves.toBe(
      'Office «Bhopal» has no timing rule covering today. Add a rule for this office, then try again.',
    );
  });

  it('sends the database reason for the employee gate when nobody is waiting on an invite', async () => {
    const { admin } = fakeAdmin(readyTables(members(member(ANN, 'active', 'Suresh'))));
    await expect(setupIncompleteMessage(admin, TENANT, NO_EMPLOYEE)).resolves.toBe(
      'No employee is enrolled for today with a live office assignment. Enrol an employee and assign them to an office, then try again.',
    );
  });

  it('falls back to the database reason when the invite lookup fails', async () => {
    const { admin } = fakeAdmin({
      ...readyTables(members()),
      attendance_enrolments: { data: null, error: { message: 'boom' } },
    });
    await expect(setupIncompleteMessage(admin, TENANT, NO_EMPLOYEE)).resolves.toMatch(
      /^No employee is enrolled for today/,
    );
  });

  it('uses the generic sentence only when the database gives no text at all', async () => {
    const { admin } = fakeAdmin({});
    await expect(setupIncompleteMessage(admin, TENANT, {})).resolves.toBe(
      'Setup needs at least one office and one tracked employee with an office assignment',
    );
  });
});
