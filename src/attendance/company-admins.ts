import type { PoolClient } from 'pg';

/**
 * The recipients of admin-facing alerts (fake-location alerts, leave events):
 * every ACTIVE company admin of the company, read when the event happens
 * (decision 36). A removed or disabled admin stops getting alerts at once, and
 * a new admin starts. Replaces the single `tenants.owner_id` recipient.
 */
export async function readCompanyAdminIds(
  tx: PoolClient,
  tenantId: string,
): Promise<string[]> {
  const result = await tx.query<{ user_id: string }>(
    `select m.user_id
       from public.memberships m
       join public.users u on u.id = m.user_id
      where m.tenant_id = $1::uuid
        and m.role = 'company_admin'
        and m.status = 'active'
        and not u.disabled
      order by m.created_at, m.user_id`,
    [tenantId],
  );
  return result.rows.map((r) => r.user_id);
}
