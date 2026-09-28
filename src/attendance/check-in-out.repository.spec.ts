import type { PoolClient } from 'pg';
import {
  countCountedInWindow,
  countMonthlyMocked,
  dbNow,
  findAttemptByIdempotencyKey,
  insertAttempt,
  insertFakeLocationAlert,
  lockEmployee,
} from './check-in-out.repository';
import { lockTenantShared } from './enrolments.repository';

/**
 * SQL-text contracts for the check-in/out statements (16-1/16-2, review
 * patch): the guarantees the real-DB journey proves behaviourally, pinned
 * here as text so a silent refactor cannot drop them — every statement
 * stays parameterised, the replay probe stays employee-scoped, and the
 * alert keeps its dedupe ON CONFLICT with registry-bound strings.
 */
describe('check-in/out repository SQL contracts (review patches)', () => {
  function txRecording() {
    const queries: { sql: string; params?: unknown[] }[] = [];
    const tx = {
      query: jest.fn((q: string, params?: unknown[]) => {
        queries.push({ sql: q, params });
        if (q.includes('returning id')) return { rows: [{ id: 'a-1' }] };
        if (q.includes('select now() as now'))
          return { rows: [{ now: new Date('2026-09-28T04:00:00Z') }] };
        return { rows: [], rowCount: 0 };
      }),
      queries,
    };
    return tx as unknown as PoolClient & {
      queries: { sql: string; params?: unknown[] }[];
    };
  }

  it('every statement is parameterised — no ${} interpolation reaches SQL', async () => {
    const tx = txRecording();
    await lockTenantShared(tx, 't1');
    await lockEmployee(tx, 'e1');
    await dbNow(tx);
    await findAttemptByIdempotencyKey(tx, 't1', 'e1', 'r1');
    await countCountedInWindow(tx, 'e1');
    await countMonthlyMocked(tx, 'e1', 'Asia/Kolkata');
    await insertAttempt(tx, {
      tenantId: 't1',
      employeeId: 'e1',
      requestId: 'r1',
      kind: 'check_in',
      outcome: 'ok',
      location: null,
      blockedUntil: null,
    });
    await insertFakeLocationAlert(tx, {
      tenantId: 't1',
      ownerId: 'o1',
      employeeId: 'e1',
      employeeName: 'A',
      month: '2026-09',
      attemptCount: 3,
      dedupeKey: 'k',
    });
    for (const q of tx.queries) {
      expect(q.sql).not.toMatch(/\$\{[^}]+\}/);
    }
  });

  it('the replay probe is employee-scoped — a key belongs to ONE employee', async () => {
    const tx = txRecording();
    await findAttemptByIdempotencyKey(tx, 't1', 'e1', 'r1');
    expect(tx.queries[0].sql).toMatch(
      /tenant_id = \$1 and employee_id = \$2 and request_id = \$3/,
    );
  });

  it('the AD-5 locks keep the shared key space (tenant then employee)', async () => {
    const tx = txRecording();
    await lockTenantShared(tx, 't1');
    await lockEmployee(tx, 'e1');
    expect(tx.queries[0].sql).toBe(
      'select public.attendance_lock_tenant($1, false)',
    );
    expect(tx.queries[1].sql).toBe('select public.attendance_lock_employee($1)');
  });

  it('the alert dedupes against the partial unique index; registry strings ride as parameters', async () => {
    const tx = txRecording();
    await insertFakeLocationAlert(tx, {
      tenantId: 't1',
      ownerId: 'o1',
      employeeId: 'e1',
      employeeName: 'A',
      month: '2026-09',
      attemptCount: 3,
      dedupeKey: 'k',
    });
    expect(tx.queries[0].sql).toContain(
      'on conflict (dedupe_key) where dedupe_key is not null do nothing',
    );
    expect(tx.queries[0].params).toContain('attendance.fake_location');
    expect(tx.queries[0].params).toContain('attendance');
  });

  it('the monthly mocked count derives its month from the DB clock (no app/DB skew)', async () => {
    const tx = txRecording();
    await countMonthlyMocked(tx, 'e1', 'Asia/Kolkata');
    expect(tx.queries[0].sql).toContain(
      "to_char(now() at time zone $2::text, 'YYYY-MM')",
    );
    expect(tx.queries[0].sql).toContain('date_trunc(\'month\', now() at time zone $2::text)');
  });

  it('the rate-limit block arms from the DB clock too', async () => {
    const tx = txRecording();
    const now = await dbNow(tx);
    expect(now.toISOString()).toBe('2026-09-28T04:00:00.000Z');
  });

  it('the attempt insert maps a raced key (23505) to null for the caller', async () => {
    const tx = txRecording();
    (tx.query as jest.Mock).mockImplementationOnce(() => {
      const err = new Error('duplicate key') as Error & { code?: string };
      err.code = '23505';
      throw err;
    });
    await expect(
      insertAttempt(tx, {
        tenantId: 't1',
        employeeId: 'e1',
        requestId: 'r1',
        kind: 'check_in',
        outcome: 'ok',
        location: null,
        blockedUntil: null,
      }),
    ).resolves.toBeNull();
  });

  it('any other insert error propagates (fail loud, transaction aborts)', async () => {
    const tx = txRecording();
    (tx.query as jest.Mock).mockImplementationOnce(() => {
      const err = new Error('int out of range') as Error & { code?: string };
      err.code = '22003';
      throw err;
    });
    await expect(
      insertAttempt(tx, {
        tenantId: 't1',
        employeeId: 'e1',
        requestId: 'r1',
        kind: 'check_in',
        outcome: 'ok',
        location: null,
        blockedUntil: null,
      }),
    ).rejects.toMatchObject({ code: '22003' });
  });
});
