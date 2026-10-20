/**
 * Throwaway companies for the member-function suites: random ids, throwaway
 * phones, registered for teardown. Real DEV database only.
 */
import { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import {
  SeedRole,
  SeedStatus,
  deleteAuditRows,
  purgeCompany,
  seedCompany,
} from './rls-seed';
import {
  randomPhone,
  setUserFlag,
  trackedPhones,
  usersByPhones,
} from './member-functions-fixture';

const madeTenants = new Set<string>();
const madePeople = new Set<string>();

export interface Roster {
  [name: string]: {
    role: SeedRole | null;
    status?: SeedStatus;
    disabled?: boolean;
  };
}
export interface Company {
  tenantId: string;
  /** person name (roster key) -> user id */
  id: Record<string, string>;
}

/**
 * One throwaway company with random ids and throwaway phones, registered for
 * teardown. The FIRST roster entry is the company's creator (tenants.created_by).
 * Each test makes its own, so tests never share mutable state.
 */
export async function makeCompany(
  service: SupabaseClient,
  label: string,
  roster: Roster,
): Promise<Company> {
  const tenantId = randomUUID();
  const names = Object.keys(roster);
  const id: Record<string, string> = {};
  for (const n of names) {
    id[n] = randomUUID();
    madePeople.add(id[n]);
  }
  madeTenants.add(tenantId);
  await seedCompany(service, {
    tenantId,
    companyName: `MFQA ${label}`,
    createdBy: id[names[0]],
    people: names.map((n) => ({
      id: id[n],
      phone: randomPhone(),
      role: roster[n].role,
      status: roster[n].status,
    })),
  });
  for (const n of names) {
    if (roster[n].disabled)
      await setUserFlag(service, id[n], { disabled: true });
  }
  return { tenantId, id };
}

/** Number of active, enabled company admins (what must never reach zero). */
export async function liveAdminCount(
  service: SupabaseClient,
  tenantId: string,
): Promise<number> {
  const { data, error } = await service
    .from('memberships')
    .select('user_id, users!memberships_user_id_fkey!inner(disabled)')
    .eq('tenant_id', tenantId)
    .eq('role', 'company_admin')
    .eq('status', 'active')
    .eq('users.disabled', false);
  expect(error).toBeNull();
  return (data ?? []).length;
}

/**
 * Remove everything a suite made: every company, then every person (seeded
 * ones by id, invited ones by throwaway phone), audit rows included.
 * Also sweeps leftovers of a crashed run (companies named "MFQA ...").
 * Order: child rows, memberships, tenants, users.
 */
export async function teardownSuite(
  service: SupabaseClient,
  tenantIds: string[] = [],
  userIds: string[] = [],
): Promise<void> {
  const invited = await usersByPhones(service, trackedPhones());
  const { data: stale } = await service
    .from('tenants')
    .select('id, created_by')
    .like('company_name', 'MFQA %');
  const staleRows = (stale ?? []) as { id: string; created_by: string }[];
  const people = [
    ...new Set([
      ...userIds,
      ...madePeople,
      ...invited,
      ...staleRows.map((t) => t.created_by),
    ]),
  ];
  const { data: owned } = await service
    .from('tenants')
    .select('id')
    .in('created_by', people);
  const tenants = [
    ...new Set([
      ...tenantIds,
      ...madeTenants,
      ...staleRows.map((t) => t.id),
      ...((owned ?? []) as { id: string }[]).map((t) => t.id),
    ]),
  ];
  // People who only hold a membership in a swept company.
  const { data: members } = await service
    .from('memberships')
    .select('user_id')
    .in('tenant_id', tenants);
  const everyone = [
    ...new Set([
      ...people,
      ...((members ?? []) as { user_id: string }[]).map((m) => m.user_id),
    ]),
  ];
  for (const t of tenants) await purgeCompany(service, t, []);
  await service.from('notifications').delete().in('user_id', everyone);
  await service.from('user_skills').delete().in('user_id', everyone);
  await service.from('memberships').delete().in('user_id', everyone);
  await deleteAuditRows(tenants, everyone);
  const { error } = await service.from('users').delete().in('id', everyone);
  if (error) throw new Error(`teardown users: ${error.message}`);
  madeTenants.clear();
  madePeople.clear();
}
