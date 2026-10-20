import type { Pool } from 'pg';

/**
 * Teardown for throwaway companies in the real-database attendance suites.
 *
 * Memberships and tenants are ON DELETE RESTRICT, and the attendance/leave
 * tables point at memberships, so a company cannot be dropped in one go any
 * more. This removes every row that hangs off the given companies (any table
 * that has a tenant_id column and points at memberships, plus notifications
 * and the audit log) and then the memberships themselves. The caller then
 * deletes the tenants and the users, in that order.
 *
 * Only ever filters by the given tenant ids — never a global delete.
 */
export async function purgeCompanyChildren(
  pool: Pool,
  tenantIds: string[],
): Promise<void> {
  // Enrolments and office assignments are checked together at commit, so they
  // go in ONE statement (a lone delete would trip the coverage trigger).
  await pool.query(
    `with a as (
       delete from public.attendance_enrolments
        where tenant_id = any($1::uuid[]) returning 1
     )
     delete from public.attendance_office_assignments
      where tenant_id = any($1::uuid[])`,
    [tenantIds],
  );
  const { rows } = await pool.query(
    `select distinct conrelid::regclass::text as t
       from pg_constraint
      where contype = 'f' and confrelid = 'public.memberships'::regclass`,
  );
  const tables: string[] = [
    'public.notifications',
    'public.audit_log',
    ...rows.map((r) => r.t as string),
  ];
  // Child tables point at each other (days -> requests, ...): retry the ones
  // that were refused until a pass removes everything.
  let pending = tables;
  for (let pass = 0; pass < 6 && pending.length > 0; pass++) {
    const refused: string[] = [];
    for (const t of pending) {
      try {
        await pool.query(`delete from ${t} where tenant_id = any($1::uuid[])`, [
          tenantIds,
        ]);
      } catch {
        refused.push(t);
      }
    }
    pending = refused;
  }
  await pool.query(
    'delete from public.memberships where tenant_id = any($1::uuid[])',
    [tenantIds],
  );
}
