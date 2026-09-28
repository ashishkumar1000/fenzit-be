import type { PoolClient } from 'pg';
import {
  cancelLeaveOnDisable,
  insertInitialLeaveDays,
  transitionLeaveDays,
} from './leave-transition';
import { ATTENDANCE_NOTIFICATION_EVENT } from './notification-events';

/**
 * QA-mindset pins for the AD-23 single writer (spec-17 D2/D12/D14): the
 * employee-lock re-take, the source-state-pinned UPDATE with rowcount
 * assert, the ONE event row, and the registry notification per cause —
 * including the dedupe key shapes (recipient embedded; the date suffix
 * for checkin_auto_cancel) and the ON CONFLICT no-op clause.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const EMPLOYEE = '22222222-2222-4222-8222-222222222222';
const RECIPIENT = '33333333-3333-4333-8333-333333333333';

function fakeTx(
  handlers: Array<(sql: string, params?: unknown[]) => unknown> = [],
) {
  const queries: { sql: string; params?: unknown[] }[] = [];
  const tx = {
    query: jest.fn((sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      for (const handler of handlers) {
        const result = handler(sql, params) as { rows?: unknown[] } | undefined;
        if (result !== undefined)
          return Promise.resolve({
            rows: result.rows ?? [],
            rowCount: result.rows?.length ?? 0,
          });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    }),
  } as unknown as PoolClient & { query: jest.Mock };
  return { tx, queries };
}

const baseTransition = {
  tenantId: TENANT,
  employeeId: EMPLOYEE,
  requestId: '11111111-1111-4111-8111-111111111111',
  leaveRequestDbId: 'req-1',
  cause: 'approve' as const,
  actorId: RECIPIENT,
  reason: null,
  notification: {
    recipientId: EMPLOYEE,
    payload: { startDate: '2026-10-01', endDate: '2026-10-02', workingDays: 2 },
  },
};

describe('transitionLeaveDays (AD-23 update path)', () => {
  it('re-takes the employee lock, pins source states in the WHERE, and casts the date array', async () => {
    const { tx, queries } = fakeTx([
      (sql) =>
        sql.includes('update public.leave_request_days')
          ? {
              rows: [
                { leave_date: '2026-10-01' },
                { leave_date: '2026-10-02' },
              ],
            }
          : undefined,
    ]);
    await transitionLeaveDays(tx, {
      ...baseTransition,
      dates: ['2026-10-01', '2026-10-02'],
      fromStates: ['pending'],
      toState: 'approved',
    });
    expect(queries[0].sql).toContain('attendance_lock_employee');
    const update = queries[1];
    expect(update.sql).toContain('state = any($4::text[])');
    expect(update.sql).toContain('leave_date = any($3::date[])');
    expect(update.params).toEqual([
      'approved',
      'req-1',
      ['2026-10-01', '2026-10-02'],
      ['pending'],
    ]);
  });

  it('writes exactly ONE event row with the cause, actor, reason and dates', async () => {
    const { tx, queries } = fakeTx([
      (sql) =>
        sql.includes('update public.leave_request_days')
          ? { rows: [{ leave_date: '2026-10-01' }] }
          : undefined,
    ]);
    await transitionLeaveDays(tx, {
      ...baseTransition,
      reason: 'Approved by owner',
      dates: ['2026-10-01'],
      fromStates: ['pending'],
      toState: 'approved',
    });
    const event = queries[2];
    expect(event.sql).toContain('insert into public.leave_events');
    expect(event.params).toEqual([
      TENANT,
      'req-1',
      EMPLOYEE,
      'approve',
      RECIPIENT,
      'Approved by owner',
      ['2026-10-01'],
    ]);
  });

  it('notifies with the registry event, the LEAVE entity type and the recipient-embedded dedupe key', async () => {
    const { tx, queries } = fakeTx([
      (sql) =>
        sql.includes('update public.leave_request_days')
          ? { rows: [{ leave_date: '2026-10-01' }] }
          : undefined,
    ]);
    await transitionLeaveDays(tx, {
      ...baseTransition,
      dates: ['2026-10-01'],
      fromStates: ['pending'],
      toState: 'approved',
    });
    const notification = queries[3];
    expect(notification.sql).toContain('insert into public.notifications');
    expect(notification.sql).toContain(
      'on conflict (dedupe_key) where dedupe_key is not null do nothing',
    );
    expect(notification.params?.[2]).toBe(
      ATTENDANCE_NOTIFICATION_EVENT.LEAVE_APPROVED,
    );
    expect(notification.params?.[4]).toBe('leave');
    expect(notification.params?.[6]).toBe(
      `${TENANT}:leave.approved:${EMPLOYEE}:11111111-1111-4111-8111-111111111111`,
    );
  });

  it('carries the date suffix in the checkin_auto_cancel dedupe key (per-date uniqueness)', async () => {
    const { tx, queries } = fakeTx([
      (sql) =>
        sql.includes('update public.leave_request_days')
          ? { rows: [{ leave_date: '2026-09-29' }] }
          : undefined,
    ]);
    await transitionLeaveDays(tx, {
      ...baseTransition,
      cause: 'checkin_auto_cancel',
      actorId: EMPLOYEE,
      dates: ['2026-09-29'],
      fromStates: ['pending', 'approved'],
      toState: 'cancelled',
      notification: {
        recipientId: RECIPIENT,
        payload: { employeeName: 'Arya', leaveDate: '2026-09-29' },
        dedupeSuffix: '2026-09-29',
      },
    });
    const notification = queries[3];
    expect(notification.params?.[2]).toBe(
      ATTENDANCE_NOTIFICATION_EVENT.LEAVE_CHECKIN_AUTO_CANCEL,
    );
    expect(notification.params?.[6]).toBe(
      `${TENANT}:leave.checkin_auto_cancel:${RECIPIENT}:11111111-1111-4111-8111-111111111111:2026-09-29`,
    );
  });

  it('rowcount mismatch aborts (a raced transition must not half-apply, D2)', async () => {
    const { tx } = fakeTx([
      (sql) =>
        sql.includes('update public.leave_request_days')
          ? { rows: [{ leave_date: '2026-10-01' }] }
          : undefined,
    ]);
    await expect(
      transitionLeaveDays(tx, {
        ...baseTransition,
        dates: ['2026-10-01', '2026-10-02'],
        fromStates: ['pending'],
        toState: 'approved',
      }),
    ).rejects.toMatchObject({
      response: { error_code: 'LEAVE_INVALID_TRANSITION' },
    });
  });

  it('answers an empty date list with no writes at all', async () => {
    const { tx, queries } = fakeTx();
    await expect(
      transitionLeaveDays(tx, {
        ...baseTransition,
        dates: [],
        fromStates: ['pending'],
        toState: 'approved',
      }),
    ).resolves.toEqual([]);
    expect(queries).toHaveLength(0);
  });

  it('removal fires the event but NO notification (FR-28)', async () => {
    const { tx, queries } = fakeTx([
      (sql) =>
        sql.includes('update public.leave_request_days')
          ? { rows: [{ leave_date: '2026-10-01' }] }
          : undefined,
    ]);
    await transitionLeaveDays(tx, {
      ...baseTransition,
      cause: 'removal',
      actorId: null,
      dates: ['2026-10-01'],
      fromStates: ['pending', 'approved'],
      toState: 'cancelled',
      notification: { recipientId: EMPLOYEE, payload: {} },
    });
    expect(
      queries.some((q) => q.sql.includes('insert into public.notifications')),
    ).toBe(false);
    expect(
      queries.some((q) => q.sql.includes('insert into public.leave_events')),
    ).toBe(true);
  });
});

describe('insertInitialLeaveDays (17-1 apply path)', () => {
  it('inserts one day row per date in the given initial state, from a date[] unnest', async () => {
    const { tx, queries } = fakeTx();
    await insertInitialLeaveDays(tx, {
      ...baseTransition,
      cause: 'apply',
      dates: ['2026-10-01', '2026-10-02', '2026-10-03'],
      initialState: 'pending',
    });
    const insert = queries[1];
    expect(insert.sql).toContain('insert into public.leave_request_days');
    expect(insert.sql).toContain('unnest($5::date[])');
    expect(insert.params?.[3]).toBe('pending');
    expect(insert.params?.[4]).toEqual([
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
    ]);
  });

  it('creates on-behalf days directly approved (FR-16)', async () => {
    const { tx, queries } = fakeTx();
    await insertInitialLeaveDays(tx, {
      ...baseTransition,
      cause: 'apply_on_behalf',
      dates: ['2026-10-01'],
      initialState: 'approved',
    });
    expect(queries[1].params?.[3]).toBe('approved');
    expect(queries[3].params?.[2]).toBe(
      ATTENDANCE_NOTIFICATION_EVENT.LEAVE_APPLIED_ON_BEHALF,
    );
  });

  it('refuses an empty span loudly (a request without days is a contract break)', async () => {
    const { tx, queries } = fakeTx();
    await expect(
      insertInitialLeaveDays(tx, {
        ...baseTransition,
        cause: 'apply',
        dates: [],
        initialState: 'pending',
      }),
    ).rejects.toMatchObject({
      status: 409,
      response: { error_code: 'LEAVE_INVALID_TRANSITION' },
    });
    expect(queries).toHaveLength(0);
  });
});

describe('cancelLeaveOnDisable (D12 ripple)', () => {
  it('cancels ALL pending days plus approved days from the effective date, per request', async () => {
    const { tx, queries } = fakeTx([
      (sql) =>
        sql.includes('from public.leave_requests r')
          ? {
              rows: [
                {
                  id: 'req-1',
                  request_id: '11111111-1111-4111-8111-111111111111',
                  start_date: '2026-09-20',
                  end_date: '2026-10-05',
                  pending: ['2026-09-25'],
                  approved: ['2026-10-05'],
                },
              ],
            }
          : sql.includes('update public.leave_request_days')
            ? {
                rows: [
                  { leave_date: '2026-09-25' },
                  { leave_date: '2026-10-05' },
                ],
              }
            : undefined,
    ]);
    const swept = await cancelLeaveOnDisable(
      tx,
      TENANT,
      EMPLOYEE,
      '2026-09-29',
    );
    expect(swept).toBe(1);
    const update = queries.find((q) =>
      q.sql.includes('update public.leave_request_days'),
    );
    expect(update?.params?.[2]).toEqual(['2026-09-25', '2026-10-05']);
    expect(update?.params?.[3]).toEqual(['pending', 'approved']);
    const event = queries.find((q) =>
      q.sql.includes('insert into public.leave_events'),
    );
    expect(event?.params?.[4]).toBeNull(); // actor NULL = system
    expect(event?.params?.[3]).toBe('disable');
    const notification = queries.find((q) =>
      q.sql.includes('insert into public.notifications'),
    );
    expect(notification?.params?.[1]).toBe(EMPLOYEE); // the employee is notified
  });

  it('sweeps nothing when the employee has no cancellable leave', async () => {
    const { tx, queries } = fakeTx([
      (sql) =>
        sql.includes('from public.leave_requests r') ? { rows: [] } : undefined,
    ]);
    await expect(
      cancelLeaveOnDisable(tx, TENANT, EMPLOYEE, '2026-09-29'),
    ).resolves.toBe(0);
    expect(
      queries.some((q) => q.sql.includes('update public.leave_request_days')),
    ).toBe(false);
  });
});
