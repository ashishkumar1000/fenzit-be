import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import {
  approverRecipients,
  loadApprovalTree,
  resolveApproversWithTree,
} from './approval-routing';
import {
  ATTENDANCE_NOTIFICATION_EVENT,
  LEAVE_ENTITY_TYPE,
} from './notification-events';

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
  const tree = await loadApprovalTree(tx, tenantId);
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
): Promise<void> {
  if (before.size === 0) return;

  const writeId = randomUUID();
  const tree = await loadApprovalTree(tx, tenantId);
  const isActive = (userId: string): boolean => {
    const member = tree.get(userId);
    return (
      member !== undefined && member.status === 'active' && !member.disabled
    );
  };

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
