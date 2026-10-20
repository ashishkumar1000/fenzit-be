/**
 * Shared helpers for the member-function integration suites
 * (member-functions-invite / -roles / -setup). Real DEV database only.
 *
 * Plain English: the five member functions (invite_member, change_member_role,
 * remove_member, set_user_disabled, setup_tenant_for_owner) are called as the
 * service role, exactly like the backend does, and each test then looks at the
 * memberships / audit_log rows with ordinary queries.
 *
 * Teardown: audit_log is append-only, so its rows are removed by
 * deleteAuditRows (triggers off for one transaction, scoped to the probe's own
 * tenants and people). Nothing here ever touches another company's rows.
 */
import { SupabaseClient } from '@supabase/supabase-js';
import { deleteAuditRows } from './rls-seed';

export const SUPABASE_URL = process.env['SUPABASE_URL'] ?? '';
export const IS_REAL_DB =
  SUPABASE_URL !== '' && !SUPABASE_URL.includes('test.supabase.co');

/** Hard stop: these suites must never run against the live project. */
export const LIVE_PROJECT_REF = 'pnlvreaijzslfymlnoti';
export const POINTS_AT_LIVE = SUPABASE_URL.includes(LIVE_PROJECT_REF);

/** Fixed, per-suite UUIDs so a crashed run is pre-cleaned by seedCompany. */
export const mid = (block: string, n: number) =>
  `00000000-0000-0000-${block}-${String(n).padStart(12, '0')}`;

const usedPhones = new Set<string>();
/** A throwaway national number: 99999 + 5 random digits, unique per run. */
export function randomPhone(): string {
  for (;;) {
    const p = `99999${String(Math.floor(Math.random() * 100000)).padStart(5, '0')}`;
    if (!usedPhones.has(p)) {
      usedPhones.add(p);
      return p;
    }
  }
}
export const trackPhone = (p: string) => (usedPhones.add(p), p);
export const trackedPhones = () => [...usedPhones];

export interface RpcError {
  code?: string;
  hint?: string | null;
  message?: string;
}
export interface RpcOut<T = unknown> {
  data: T | null;
  error: RpcError | null;
}

export async function call<T = Record<string, unknown>[]>(
  service: SupabaseClient,
  fn: string,
  args: Record<string, unknown>,
): Promise<RpcOut<T>> {
  const res = await service.rpc(fn, args);
  return { data: res.data as T | null, error: res.error as RpcError | null };
}

/** What the backend reads off a refused call: errcode + API hint. */
export const refusal = (r: RpcOut) => ({
  code: r.error?.code,
  hint: r.error?.hint,
});
export const REFUSED = (code: string, hint: string) => ({ code, hint });
export const FORBIDDEN = REFUSED('PT403', 'FORBIDDEN');
export const DUPLICATE = REFUSED('PT409', 'DUPLICATE_RESOURCE');
export const ALREADY_IN_TEAM = REFUSED('PT409', 'ALREADY_IN_TEAM');
export const PLATFORM_STAFF = REFUSED('PT400', 'PLATFORM_STAFF_NOT_MEMBER');
export const VALIDATION = REFUSED('PT400', 'VALIDATION_ERROR');
export const NOT_FOUND = REFUSED('PT404', 'RESOURCE_NOT_FOUND');
export const LAST_ADMIN = REFUSED('PT409', 'LAST_ADMIN');

export interface MemberRow {
  id: string;
  user_id: string;
  tenant_id: string;
  role: string;
  status: string;
  employee_code: string;
  invited_by: string | null;
}

export async function membershipsOf(
  service: SupabaseClient,
  userId: string,
): Promise<MemberRow[]> {
  const { data, error } = await service
    .from('memberships')
    .select('id, user_id, tenant_id, role, status, employee_code, invited_by')
    .eq('user_id', userId);
  expect(error).toBeNull();
  return data as MemberRow[];
}

export async function membershipIn(
  service: SupabaseClient,
  userId: string,
  tenantId: string,
): Promise<MemberRow | null> {
  const rows = (await membershipsOf(service, userId)).filter(
    (m) => m.tenant_id === tenantId,
  );
  return rows[0] ?? null;
}

export interface AuditRow {
  actor_user_id: string;
  actor_is_platform_admin: boolean;
  tenant_id: string | null;
  action: string;
  target_user_id: string | null;
  details: Record<string, unknown>;
}

/** Audit rows for one person acted on (target) with an optional action filter. */
export async function auditFor(
  service: SupabaseClient,
  targetUserId: string,
  action?: string,
): Promise<AuditRow[]> {
  let q = service
    .from('audit_log')
    .select(
      'actor_user_id, actor_is_platform_admin, tenant_id, action, target_user_id, details',
    )
    .eq('target_user_id', targetUserId);
  if (action) q = q.eq('action', action);
  const { data, error } = await q;
  expect(error).toBeNull();
  return data as AuditRow[];
}

export async function auditCountForTenant(
  service: SupabaseClient,
  tenantId: string,
): Promise<number> {
  const { count, error } = await service
    .from('audit_log')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', tenantId);
  expect(error).toBeNull();
  return count ?? 0;
}

export async function setUserFlag(
  service: SupabaseClient,
  userId: string,
  patch: { disabled?: boolean; platform_admin?: boolean },
): Promise<void> {
  const { error } = await service.from('users').update(patch).eq('id', userId);
  expect(error).toBeNull();
}

/** An identity-only fenzit staff user (platform_admin flag, no membership). */
export async function seedPlatformAdmin(
  service: SupabaseClient,
  id: string,
  phone: string,
): Promise<void> {
  await deleteAuditRows([], [id]);
  await service.from('users').delete().eq('id', id);
  const { error } = await service.from('users').insert({
    id,
    country_code: '+91',
    phone_number: phone,
    platform_admin: true,
  });
  expect(error).toBeNull();
}

/** Ids of users whose phone is one of the throwaway numbers this run made. */
export async function usersByPhones(
  service: SupabaseClient,
  phones: string[],
): Promise<string[]> {
  if (phones.length === 0) return [];
  const { data, error } = await service
    .from('users')
    .select('id')
    .in('phone_number', phones);
  expect(error).toBeNull();
  return (data as { id: string }[]).map((u) => u.id);
}
