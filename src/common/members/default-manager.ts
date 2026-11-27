import type { PoolClient } from 'pg';

/**
 * The company's default reporting manager (story 24-8): every non-admin
 * member always has one, so "no manager" is not a state the product can show.
 *
 * The tenant owner is the default while they still serve. An owner can be
 * deactivated or removed as a member once another admin exists (the last-admin
 * rule only protects the final one), so the answer falls back to the earliest
 * active admin. Null means the company has no active admin at all, which the
 * last-admin rule makes unreachable — callers treat it as "leave unassigned"
 * rather than inventing one.
 *
 * `excludeUserId` keeps the person who is leaving (being deactivated or
 * removed) out of the answer, so a re-parent never points their reports back
 * at them.
 */
export async function resolveDefaultManager(
  tx: PoolClient,
  tenantId: string,
  excludeUserId: string | null = null,
): Promise<string | null> {
  const { rows } = await tx.query<{ user_id: string }>(
    `select m.user_id
       from public.memberships m
       join public.users u on u.id = m.user_id
       join public.tenants t on t.id = m.tenant_id
      where m.tenant_id = $1
        and m.role = 'company_admin'
        and m.status = 'active'
        and not u.disabled
        and ($2::uuid is null or m.user_id <> $2)
      order by (m.user_id = t.owner_id) desc, m.created_at, m.user_id
      limit 1`,
    [tenantId, excludeUserId],
  );
  return rows[0]?.user_id ?? null;
}
