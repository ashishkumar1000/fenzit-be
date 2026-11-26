import { PoolClient } from 'pg';

/**
 * How deep a company tree may get (admins are level 1). Shared by the read
 * helper and the write guards so the cap is stated once; story 2's subtree
 * walk reuses it too.
 */
export const MAX_HIERARCHY_DEPTH = 20;

/** One step up the reporting tree: the manager's id and their name. */
export interface MemberChainLink {
  userId: string;
  name: string;
}

/**
 * The hierarchy fields a member payload carries. `chain` is nearest-first
 * ("Reports to Priya → Arjun (Owner)"); `headcount` counts everyone strictly
 * below the member, `directReports` the immediate count, which the re-parent
 * warning ("Priya's 3 direct reports") needs.
 *
 * Removed memberships and disabled accounts are not counted — they are not
 * part of the team — but an invited or deactivated (parked) member is: their
 * row is still on the roster.
 */
export interface MemberHierarchy {
  managerId: string | null;
  managerName: string | null;
  chain: MemberChainLink[];
  headcount: number;
  directReports: number;
}

/** A member with no manager and no reports. */
export function emptyHierarchy(): MemberHierarchy {
  return {
    managerId: null,
    managerName: null,
    chain: [],
    headcount: 0,
    directReports: 0,
  };
}

type Queryable = Pick<PoolClient, 'query'>;

/**
 * Builds the hierarchy for the named members from TWO queries, each scoped to
 * the requested ids (not the whole company, which would make a page read pay
 * for every member's tree).
 *
 * Each membership stores only its own manager pointer, so the upward chain is
 * a recursive walk seeded at the requested ids. The downward walk is seeded the
 * same way and carries the root it started from, so one page can hold both a
 * manager and their report without either count leaking into the other.
 *
 * Both walks are depth-capped and deduplicated so a corrupt tree (a loop
 * written by hand) cannot spin.
 *
 * Only the company's live members take part: `removed` rows are history and
 * a disabled account cannot sign in, so neither is counted in a headcount.
 */
export async function readMemberHierarchy(
  tx: Queryable,
  tenantId: string,
  memberIds: string[],
): Promise<Map<string, MemberHierarchy>> {
  const result = new Map<string, MemberHierarchy>();
  if (memberIds.length === 0) return result;
  for (const id of memberIds) result.set(id, emptyHierarchy());

  const live = `live as (
       select m.user_id, m.manager_id, u.name, u.disabled
         from public.memberships m
         join public.users u on u.id = m.user_id
        where m.tenant_id = $1 and m.status <> 'removed'
     )`;

  const up = await tx.query<{
    node_id: string;
    ancestor_id: string;
    depth: number;
    name: string;
  }>(
    `with recursive ${live},
     up as (
       select m.user_id as node_id, m.manager_id as ancestor_id, 1 as depth
         from live m
        where m.user_id = any($2::uuid[]) and m.manager_id is not null
       union all
       select u.node_id, p.manager_id, u.depth + 1
         from up u
         join live p on p.user_id = u.ancestor_id
        where u.depth < ${MAX_HIERARCHY_DEPTH} and p.manager_id is not null
     )
     select u.node_id, u.ancestor_id, u.depth, a.name
       from up u
       join live a on a.user_id = u.ancestor_id
      where u.ancestor_id <> u.node_id
      order by u.node_id, u.depth`,
    [tenantId, memberIds],
  );

  for (const row of up.rows) {
    // A hand-written loop can make the member their own ancestor; never render
    // that as "reports to yourself".
    if (row.ancestor_id === row.node_id) continue;
    const entry = result.get(row.node_id);
    if (!entry || entry.chain.some((link) => link.userId === row.ancestor_id)) {
      continue;
    }
    entry.chain.push({ userId: row.ancestor_id, name: row.name });
    if (row.depth === 1) {
      entry.managerId = row.ancestor_id;
      entry.managerName = row.name;
    }
  }

  const down = await tx.query<{
    root_id: string;
    node_id: string;
    depth: number;
    disabled: boolean;
  }>(
    `with recursive ${live},
     down as (
       select m.user_id as node_id, m.user_id as root_id, 0 as depth
         from live m
        where m.user_id = any($2::uuid[])
       union
       select c.user_id, d.root_id, d.depth + 1
         from down d
         join live c on c.manager_id = d.node_id
        where d.depth < ${MAX_HIERARCHY_DEPTH + 1}
     )
     select d.root_id, d.node_id, d.depth, n.disabled
       from down d
       join live n on n.user_id = d.node_id
      where d.depth > 0`,
    [tenantId, memberIds],
  );

  const counted = new Set<string>();
  for (const row of down.rows) {
    const entry = result.get(row.root_id);
    if (!entry || row.disabled) continue;
    // A corrupt loop can reach the same person at several depths; count them
    // once, unlike the direct-report flag which keys on the first rung only.
    const key = `${row.root_id}:${row.node_id}`;
    if (counted.has(key)) continue;
    counted.add(key);
    entry.headcount += 1;
    if (row.depth === 1) entry.directReports += 1;
  }

  return result;
}

/**
 * Every live member below `managerId` (the reporting subtree), excluding the
 * manager themself. One capped, deduplicated walk so a corrupt loop written by
 * hand cannot spin; `removed` memberships are history and are not part of a
 * team. Callers add `self` when the scope is "my rows plus my team".
 */
export async function readSubtreeMemberIds(
  tx: Queryable,
  tenantId: string,
  managerId: string,
): Promise<string[]> {
  const result = await tx.query<{ node_id: string }>(
    `with recursive down as (
       select m.user_id as node_id, 0 as depth
         from public.memberships m
         join public.users u on u.id = m.user_id
        where m.tenant_id = $1 and m.user_id = $2::uuid
          and m.status <> 'removed' and not u.disabled
       union
       select c.user_id, d.depth + 1
         from down d
         join public.memberships c
           on c.tenant_id = $1 and c.manager_id = d.node_id
         join public.users cu on cu.id = c.user_id
        where d.depth < ${MAX_HIERARCHY_DEPTH + 1}
          and c.status <> 'removed' and not cu.disabled
     )
     select d.node_id from down d where d.depth > 0`,
    [tenantId, managerId],
  );
  // A loop can reach the same person at several depths; ids are the contract.
  return [...new Set(result.rows.map((row) => row.node_id))];
}

/**
 * The two tree facts a manager assignment needs, in one round trip:
 *
 * - `cycle` — the proposed manager's own upward chain reaches the member, so
 *   the write would close a loop.
 * - `managerAncestors` — how many managers stand above the proposed manager.
 *   The member's level after the write is that number + 2 (the admins are
 *   level 1), and their subtree depth is `subtreeDepth`; the deepest level in
 *   the affected branch is the sum, which must stay within the cap.
 */
export async function probeManagerAssignment(
  tx: Queryable,
  tenantId: string,
  memberId: string,
  managerId: string,
): Promise<{ cycle: boolean; managerAncestors: number; subtreeDepth: number }> {
  const probe = await tx.query<{
    cycle: boolean;
    manager_ancestors: number;
    subtree_depth: number;
  }>(
    `with recursive live as (
       select m.user_id, m.manager_id
         from public.memberships m
        where m.tenant_id = $1 and m.status <> 'removed'
     ),
     up as (
       select m.manager_id as ancestor_id, 1 as depth
         from live m
        where m.user_id = $2 and m.manager_id is not null
       union all
       select p.manager_id, u.depth + 1
         from up u
         join live p on p.user_id = u.ancestor_id
        where u.depth < ${MAX_HIERARCHY_DEPTH} and p.manager_id is not null
     ),
     down as (
       select $3::uuid as node_id, 0 as depth
       union all
       select m.user_id, d.depth + 1
         from down d
         join live m on m.manager_id = d.node_id
        where d.depth < ${MAX_HIERARCHY_DEPTH + 1}
     )
     select exists (select 1 from up where ancestor_id = $3) as cycle,
            (select count(*)::int from up) as manager_ancestors,
            (select coalesce(max(depth), 0)::int from down) as subtree_depth`,
    [tenantId, managerId, memberId],
  );
  const row = probe.rows[0];
  return {
    cycle: row?.cycle ?? false,
    managerAncestors: row?.manager_ancestors ?? 0,
    subtreeDepth: row?.subtree_depth ?? 0,
  };
}
