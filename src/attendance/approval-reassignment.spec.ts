import { PoolClient } from 'pg';
import {
  emitJobApproverSetChanges,
  PendingJobSnapshot,
} from './approval-reassignment';
import { ApprovalTree } from './approval-routing';
import { pushCopyForEvent } from '../push/push-copy';

/**
 * 24-4 — the job-side set-difference notices. The members.service spec proves
 * the four tree writes call this diff; here we pin the emitter itself: the
 * payload contract the push sweep reads and the per-write dedupe suffix that
 * lets an approver be told again after the set returns to them.
 */

const TENANT = 'tenant-A';
const JOB_ID = '11111111-1111-4111-8111-111111111111';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function snapshot(approvers: string[]): PendingJobSnapshot {
  return {
    jobDbId: JOB_ID,
    jobNumber: 'JB-2026-0001',
    employeeName: 'Ravi',
    customerName: 'Asha',
    approvers,
  };
}

const snapshots = (approvers: string[]) =>
  new Map<string, PendingJobSnapshot>([[JOB_ID, snapshot(approvers)]]);

const tree = new Map([
  [
    A,
    {
      user_id: A,
      manager_id: null,
      role: 'employee',
      status: 'active',
      disabled: false,
    },
  ],
  [
    B,
    {
      user_id: B,
      manager_id: null,
      role: 'employee',
      status: 'active',
      disabled: false,
    },
  ],
]) as unknown as ApprovalTree;

type Insert = {
  recipient: string;
  event: string;
  payload: Record<string, unknown>;
  dedupeKey: string;
};

function capturingTx() {
  const inserts: Insert[] = [];
  const tx = {
    query: jest.fn((sql: string, params?: unknown[]) => {
      if (!sql.includes('insert into public.notifications')) {
        throw new Error(`unexpected query: ${sql}`);
      }
      inserts.push({
        recipient: params?.[1] as string,
        event: params?.[3] as string,
        payload: JSON.parse(params?.[4] as string) as Record<string, unknown>,
        dedupeKey: params?.[5] as string,
      });
      return Promise.resolve({ rows: [] });
    }),
  } as unknown as PoolClient;
  return { tx, inserts };
}

describe('job approver set-difference notices (24-4)', () => {
  it('notifies the added and the removed approver with the job push payload', async () => {
    const { tx, inserts } = capturingTx();

    await emitJobApproverSetChanges(
      tx,
      TENANT,
      snapshots([A]),
      snapshots([B]),
      tree,
    );

    expect(inserts.map((i) => [i.event, i.recipient])).toEqual([
      ['job.approver_added', B],
      ['job.approver_removed', A],
    ]);
    // Producer → consumer: the durable payload must feed the push copy.
    const push = pushCopyForEvent('job.approver_added', inserts[0].payload);
    expect(push.body).toContain('JB-2026-0001');
    expect(push.body).toContain('Asha');
    expect(push.body).toContain('Ravi');
  });

  it('re-notifies when the set returns (A→B→A→B) because each write gets a fresh key', async () => {
    const { tx, inserts } = capturingTx();

    await emitJobApproverSetChanges(
      tx,
      TENANT,
      snapshots([A]),
      snapshots([B]),
      tree,
    );
    await emitJobApproverSetChanges(
      tx,
      TENANT,
      snapshots([B]),
      snapshots([A]),
      tree,
    );
    await emitJobApproverSetChanges(
      tx,
      TENANT,
      snapshots([A]),
      snapshots([B]),
      tree,
    );

    const addedForB = inserts.filter(
      (i) => i.event === 'job.approver_added' && i.recipient === B,
    );
    expect(addedForB).toHaveLength(2);
    // Without the per-write suffix the second insertion collides with the
    // global dedupe index and is swallowed with no error.
    expect(new Set(addedForB.map((i) => i.dedupeKey)).size).toBe(2);
    expect(new Set(inserts.map((i) => i.dedupeKey)).size).toBe(inserts.length);
    expect(inserts.map((i) => i.event)).toEqual([
      'job.approver_added',
      'job.approver_removed',
      'job.approver_added',
      'job.approver_removed',
      'job.approver_added',
      'job.approver_removed',
    ]);
  });

  it('writes no notice for a job that vanished from the after-map', async () => {
    const { tx, inserts } = capturingTx();

    await emitJobApproverSetChanges(
      tx,
      TENANT,
      snapshots([A]),
      new Map<string, PendingJobSnapshot>(),
      tree,
    );

    expect(inserts).toEqual([]);
  });
});
