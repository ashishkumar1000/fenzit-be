import type { PoolClient } from 'pg';
import { MAX_HIERARCHY_DEPTH } from '../common/members/hierarchy';
import { Role } from '../common/enums/role.enum';

/** One membership as the routing walk sees it. */
export interface RoutingMember {
  userId: string;
  managerId: string | null;
  role: string;
  status: string;
  disabled: boolean;
}

export type ApprovalTree = Map<string, RoutingMember>;

/**
 * Who may decide a leave request (approval-routing.md).
 *
 * - `self` — the requester is an admin: they decide it themself (D11), and a
 *   submission notifies no one.
 * - `single` — the nearest eligible manager above the requester.
 * - `fallback` — all active admins minus the actor, when the walk steps up from
 *   an unassigned member (D12).
 * - `unresolved` — ownerless company or a corrupt tree: nothing decides, and
 *   nothing is auto-approved.
 */
export type ApproverSet =
  | { kind: 'self'; userId: string }
  | { kind: 'single'; userId: string }
  | { kind: 'fallback'; userIds: string[] }
  | { kind: 'unresolved'; reason: 'ownerless' | 'corrupt' };

/** The recipients a submission notifies — `self` and `unresolved` notify no one. */
export function approverRecipients(set: ApproverSet): string[] {
  switch (set.kind) {
    case 'single':
      return [set.userId];
    case 'fallback':
      return set.userIds;
    default:
      return [];
  }
}

export function mayDecide(
  set: ApproverSet,
  callerId: string,
  callerIsAdmin: boolean,
): boolean {
  if (callerIsAdmin) return true; // the admin override (CAP-3)
  // UUID case is not significant; Postgres returns lowercase ids, so a
  // mixed-case caller id must still match the walk's answer.
  const caller = callerId.toLowerCase();
  if (set.kind === 'single') return set.userId.toLowerCase() === caller;
  if (set.kind === 'fallback') {
    return set.userIds.some((id) => id.toLowerCase() === caller);
  }
  return false;
}

/** One read of the company's memberships, reusable for several walks. */
export async function loadApprovalTree(
  tx: PoolClient,
  tenantId: string,
): Promise<ApprovalTree> {
  const res = await tx.query<{
    user_id: string;
    manager_id: string | null;
    role: string;
    status: string;
    disabled: boolean;
  }>(
    `select m.user_id, m.manager_id, m.role::text, m.status::text, u.disabled
       from public.memberships m
       join public.users u on u.id = m.user_id
      where m.tenant_id = $1`,
    [tenantId],
  );
  const tree: ApprovalTree = new Map();
  for (const row of res.rows) {
    tree.set(row.user_id, {
      userId: row.user_id,
      managerId: row.manager_id,
      role: row.role,
      status: row.status,
      disabled: row.disabled,
    });
  }
  return tree;
}

/**
 * The membership role arrives from `role::text` as a plain string; pin the
 * enum's value as a string so the comparisons stay type-clean.
 */
export const ADMIN_ROLE: string = Role.COMPANY_ADMIN;

function isActive(member: RoutingMember | undefined): boolean {
  return member !== undefined && member.status === 'active' && !member.disabled;
}

function activeAdmins(tree: ApprovalTree): string[] {
  return [...tree.values()]
    .filter((m) => isActive(m) && m.role === ADMIN_ROLE)
    .map((m) => m.userId)
    .sort();
}

/**
 * The resolved approver set, computed at action time (never stored on the
 * request). `actorId` is the person who filed the request — the requester for
 * a self-filing, the manager for an on-behalf filing — and is excluded so the
 * actor never decides their own filing (D14).
 */
export function resolveApproversWithTree(
  tree: ApprovalTree,
  requesterId: string,
  actorId: string,
): ApproverSet {
  // UUID case is not significant, but Map lookups are: normalise at the
  // boundary so a mixed-case client id never reads as a corrupt tree.
  const requesterKey = requesterId.toLowerCase();
  const actor = actorId.toLowerCase();
  const requester = tree.get(requesterKey);
  if (!requester) return { kind: 'unresolved', reason: 'corrupt' };
  if (isActive(requester) && requester.role === ADMIN_ROLE) {
    return { kind: 'self', userId: requester.userId };
  }

  const fallback = (): ApproverSet => {
    const admins = activeAdmins(tree).filter((id) => id !== actor);
    return admins.length > 0
      ? { kind: 'fallback', userIds: admins }
      : { kind: 'unresolved', reason: 'ownerless' };
  };

  // Bounded walk with a visited set: a corrupt loop answers `corrupt` instead
  // of spinning (approval-routing.md rule 4).
  const visited = new Set<string>([requesterKey]);
  let current = requester.managerId;
  let steps = 0;
  while (current !== null) {
    steps += 1;
    if (steps > MAX_HIERARCHY_DEPTH + 1 || visited.has(current)) {
      return { kind: 'unresolved', reason: 'corrupt' };
    }
    visited.add(current);

    const candidate = tree.get(current);
    if (!candidate) return fallback(); // the chain leaves the company
    if (isActive(candidate) && current !== actor) {
      // The nearest eligible member decides, assigned or not: being
      // unassigned only defines what happens when the walk steps UP past them.
      return { kind: 'single', userId: current };
    }
    // Inactive, removed, disabled or the actor: climb past them. An unassigned
    // member's up-step is the fallback set.
    if (candidate.managerId === null) return fallback();
    current = candidate.managerId;
  }
  // The requester has no manager at all and is not an admin.
  return fallback();
}

export async function resolveApprovers(
  tx: PoolClient,
  tenantId: string,
  requesterId: string,
  actorId: string,
): Promise<ApproverSet> {
  const tree = await loadApprovalTree(tx, tenantId);
  return resolveApproversWithTree(tree, requesterId, actorId);
}
