import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import {
  approverRecipients,
  loadApprovalTree,
  resolveApproversWithTree,
  type ApprovalTree,
} from './approval-routing';
import {
  ATTENDANCE_NOTIFICATION_EVENT,
  LEAVE_ENTITY_TYPE,
} from './notification-events';
import { PENDING_JOB_EVENT } from '../jobs/pending-job-notifications';

/** One pending request as the reassignment diff needs it. */
export interface PendingApprovalSnapshot {
  requestDbId: string;
  /** The client idempotency uuid — the notification dedupe entity segment. */
  requestKey: string;
  employeeName: string | null;
  startDate: string;
  endDate: string;
  approvers: string[];
}

/**
 * The resolved set of every pending request filed by one of `requesterIds`,
 * read against the CURRENT tree. Called once before a tree write and once
 * after it, in the same transaction, so the difference is exact.
 */
export async function readPendingApprovalSnapshots(
  tx: PoolClient,
  tenantId: string,
  requesterIds: string[],
  preloadedTree?: ApprovalTree,
): Promise<Map<string, PendingApprovalSnapshot>> {
  const result = new Map<string, PendingApprovalSnapshot>();
  if (requesterIds.length === 0) return result;

  const rows = await tx.query<{
    id: string;
    request_id: string;
    employee_id: string;
    created_by: string;
    start_date: string;
    end_date: string;
    employee_name: string | null;
  }>(
    `select r.id, r.request_id, r.employee_id, r.created_by,
            r.start_date::text, r.end_date::text, u.name as employee_name
       from public.leave_requests r
       join public.users u on u.id = r.employee_id
      where r.tenant_id = $1
        and r.employee_id = any($2::uuid[])
        and exists (
          select 1 from public.leave_request_days d
           where d.leave_request_id = r.id and d.state = 'pending'
        )`,
    [tenantId, requesterIds],
  );
  const tree = preloadedTree ?? (await loadApprovalTree(tx, tenantId));
  for (const row of rows.rows) {
    // A non-live requester has no routing left to change: their own pending
    // request belongs to the removal/disable flow, not to reassignment. The
    // tree carries every membership (removed included), so check the state,
    // not just presence — otherwise a just-removed member's request would
    // fan "awaiting your approval" out to every admin.
    const requester = tree.get(row.employee_id);
    if (
      requester === undefined ||
      requester.status !== 'active' ||
      requester.disabled
    ) {
      continue;
    }
    const set = resolveApproversWithTree(tree, row.employee_id, row.created_by);
    result.set(row.id, {
      requestDbId: row.id,
      requestKey: row.request_id,
      employeeName: row.employee_name,
      startDate: row.start_date,
      endDate: row.end_date,
      approvers: approverRecipients(set),
    });
  }
  return result;
}

async function notify(
  tx: PoolClient,
  tenantId: string,
  eventType: (typeof ATTENDANCE_NOTIFICATION_EVENT)[keyof typeof ATTENDANCE_NOTIFICATION_EVENT],
  snapshot: PendingApprovalSnapshot,
  recipientIds: string[],
  writeId: string,
): Promise<void> {
  for (const recipientId of recipientIds) {
    await tx.query(
      `insert into public.notifications
         (tenant_id, user_id, job_id, event_type, payload,
          entity_type, entity_id, dedupe_key)
       values ($1::uuid, $2::uuid, null, $3::text, $4::jsonb,
               $5::text, $6::uuid, $7::text)
       on conflict (dedupe_key) where dedupe_key is not null do nothing`,
      [
        tenantId,
        recipientId,
        eventType,
        JSON.stringify({
          employeeName: snapshot.employeeName,
          startDate: snapshot.startDate,
          endDate: snapshot.endDate,
        }),
        LEAVE_ENTITY_TYPE,
        snapshot.requestDbId,
        // The write id makes a re-entry (A→B→A) notify again; the tree
        // transaction is exclusive, so one tree write = one opportunity.
        `${tenantId}:${eventType}:${recipientId}:${snapshot.requestKey}:${writeId}`,
      ],
    );
  }
}

/**
 * CAP-4's set-difference notices: for every pending request touched by a tree
 * write, members that entered the resolved set hear "now awaiting your
 * approval", members that left it hear "no longer yours to approve" — skipped
 * when they are no longer active. Runs inside the tree transaction.
 */
export async function emitApproverSetChanges(
  tx: PoolClient,
  tenantId: string,
  before: Map<string, PendingApprovalSnapshot>,
  after: Map<string, PendingApprovalSnapshot>,
  preloadedTree?: ApprovalTree,
): Promise<void> {
  if (before.size === 0) return;

  const writeId = randomUUID();
  const tree = preloadedTree ?? (await loadApprovalTree(tx, tenantId));
  const isActive = (userId: string): boolean => isLiveMember(tree, userId);

  for (const [requestDbId, previous] of before) {
    const next = after.get(requestDbId);
    if (!next) continue;
    const added = next.approvers.filter(
      (id) => !previous.approvers.includes(id),
    );
    const removed = previous.approvers.filter(
      (id) => !next.approvers.includes(id) && isActive(id),
    );
    await notify(
      tx,
      tenantId,
      ATTENDANCE_NOTIFICATION_EVENT.LEAVE_APPROVER_ADDED,
      next,
      added,
      writeId,
    );
    await notify(
      tx,
      tenantId,
      ATTENDANCE_NOTIFICATION_EVENT.LEAVE_APPROVER_REMOVED,
      next,
      removed,
      writeId,
    );
  }
}

/**
 * The requesters whose walk can change when `memberId`'s own position changes:
 * the member themself plus everyone below them (their chains pass through the
 * member).
 */
export function affectedApprovalRequesters(
  memberId: string,
  subtreeIds: string[],
): string[] {
  return [memberId, ...subtreeIds];
}

/** One pending job as the reassignment diff needs it. */
export interface PendingJobSnapshot {
  jobDbId: string;
  jobNumber: string;
  employeeName: string | null;
  customerName: string | null;
  approvers: string[];
}

function isLiveMember(tree: ApprovalTree, userId: string): boolean {
  const member = tree.get(userId);
  return member !== undefined && member.status === 'active' && !member.disabled;
}

/**
 * The resolved approver set of every pending job created by one of
 * `requesterIds`, read against the CURRENT tree. The job equivalent of
 * `readPendingApprovalSnapshots`, for the tree-write diff.
 */
export async function readPendingJobSnapshots(
  tx: PoolClient,
  tenantId: string,
  requesterIds: string[],
  preloadedTree?: ApprovalTree,
): Promise<Map<string, PendingJobSnapshot>> {
  const result = new Map<string, PendingJobSnapshot>();
  if (requesterIds.length === 0) return result;

  const rows = await tx.query<{
    id: string;
    job_number: string;
    created_by: string;
    employee_name: string | null;
    customer_name: string | null;
  }>(
    `select j.id, j.job_number, j.created_by,
            u.name as employee_name, c.name as customer_name
       from public.jobs j
       join public.users u on u.id = j.created_by
       left join public.customers c on c.id = j.customer_id
      where j.tenant_id = $1
        and j.created_by = any($2::uuid[])
        and j.status = 'pending_approval'`,
    [tenantId, requesterIds],
  );
  const tree = preloadedTree ?? (await loadApprovalTree(tx, tenantId));
  for (const row of rows.rows) {
    // Same rule as leave: a non-live creator's job belongs to the removal /
    // disable flow, not to reassignment.
    if (!isLiveMember(tree, row.created_by)) continue;
    const set = resolveApproversWithTree(tree, row.created_by, row.created_by);
    result.set(row.id, {
      jobDbId: row.id,
      jobNumber: row.job_number,
      employeeName: row.employee_name,
      customerName: row.customer_name,
      approvers: approverRecipients(set),
    });
  }
  return result;
}

async function notifyJob(
  tx: PoolClient,
  tenantId: string,
  eventType: string,
  snapshot: PendingJobSnapshot,
  recipientIds: string[],
  writeId: string,
): Promise<void> {
  for (const recipientId of recipientIds) {
    await tx.query(
      `insert into public.notifications
         (tenant_id, user_id, job_id, event_type, payload, dedupe_key)
       values ($1::uuid, $2::uuid, $3::uuid, $4::text, $5::jsonb, $6::text)
       on conflict (dedupe_key) where dedupe_key is not null do nothing`,
      [
        tenantId,
        recipientId,
        snapshot.jobDbId,
        eventType,
        // Snake_case is the notifications payload contract every job notice
        // uses (job.submitted, approval decision) and the key shape
        // `pushCopyForEvent` reads. CamelCase here silently produced an empty
        // push body.
        JSON.stringify({
          job_number: snapshot.jobNumber,
          customer_name: snapshot.customerName,
          employee_name: snapshot.employeeName,
        }),
        `${tenantId}:${eventType}:${recipientId}:${snapshot.jobDbId}:${writeId}`,
      ],
    );
  }
}

/** The job-side set-difference notices (24-4), same rules as leave. */
export async function emitJobApproverSetChanges(
  tx: PoolClient,
  tenantId: string,
  before: Map<string, PendingJobSnapshot>,
  after: Map<string, PendingJobSnapshot>,
  preloadedTree?: ApprovalTree,
  actorId?: string,
): Promise<void> {
  if (before.size === 0) return;

  const writeId = randomUUID();
  const tree = preloadedTree ?? (await loadApprovalTree(tx, tenantId));
  for (const [jobDbId, previous] of before) {
    const next = after.get(jobDbId);
    if (!next) continue;
    const added = next.approvers.filter(
      // The actor never rings their own bell: an admin who makes themself the
      // report's manager already knows they took the job over (24-4 contract).
      (id) => !previous.approvers.includes(id) && id !== actorId,
    );
    const removed = previous.approvers.filter(
      (id) => !next.approvers.includes(id) && isLiveMember(tree, id),
    );
    await notifyJob(
      tx,
      tenantId,
      PENDING_JOB_EVENT.APPROVER_ADDED,
      next,
      added,
      writeId,
    );
    await notifyJob(
      tx,
      tenantId,
      PENDING_JOB_EVENT.APPROVER_REMOVED,
      next,
      removed,
      writeId,
    );
  }
}
