/**
 * Seeding and token helpers for the real-database row-level-security suites
 * (rls-isolation / rls-membership-policies).
 *
 * Plain English: a person's company and role now come from their MEMBERSHIP
 * row, not from the token. So every test person needs a users row (identity)
 * and, to see anything company-scoped, an ACTIVE membership in a company.
 *
 * Seeding order: users -> tenants (created_by) -> memberships.
 * Teardown order: child rows -> memberships -> tenants -> users.
 *
 * audit_log is append-only (a trigger refuses update/delete even for the
 * service role) and its foreign keys RESTRICT, so a throwaway company that
 * ever got an audit row can only be removed after those rows are deleted with
 * triggers switched off for ONE transaction, scoped to the probe's own ids.
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as jwt from 'jsonwebtoken';
import { Client } from 'pg';

export type SeedRole = 'company_admin' | 'employee' | 'viewer';
export type SeedStatus = 'invited' | 'active' | 'removed';

export interface SeedPerson {
  id: string;
  /** Unique across the whole users table (national number, '+91'). */
  phone: string;
  /** null = identity only, no membership (a stranger). */
  role: SeedRole | null;
  /** Defaults to 'active'. */
  status?: SeedStatus;
}

const url = () => process.env['SUPABASE_URL'] ?? '';
const anonKey = () => process.env['SUPABASE_ANON_KEY'] ?? '';

/** A direct-API token: `{ sub, role: 'authenticated', exp }` (+ any extras). */
export function mintJwt(
  userId: string,
  extraClaims: Record<string, unknown> = {},
): string {
  return jwt.sign(
    { sub: userId, role: 'authenticated', ...extraClaims },
    process.env['SUPABASE_JWT_SECRET'] ?? '',
    { algorithm: 'HS256', expiresIn: '1h' },
  );
}

const noSession = { persistSession: false, autoRefreshToken: false };

export function serviceRoleClient(): SupabaseClient {
  const key = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';
  if (key === '') throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
  return createClient(url(), key, { auth: noSession });
}

/** Anon-key client; with a token it behaves like a signed-in API caller. */
export function apiClient(token?: string): SupabaseClient {
  return createClient(url(), anonKey(), {
    ...(token
      ? { global: { headers: { Authorization: `Bearer ${token}` } } }
      : {}),
    auth: noSession,
  });
}

function must(label: string, error: { message: string } | null): void {
  if (error) throw new Error(`${label}: ${error.message}`);
}

/** Tenant-scoped tables a probe may fill, children before parents. */
const TENANT_TABLES = [
  'attachments',
  'attachment_uploads',
  'activity_logs',
  'idempotency_log',
  'report_requests',
  'notifications',
  'jobs',
  'customers',
  'attendance_weekly_off_overrides',
  'attendance_weekly_off_defaults',
  'holidays',
  'attendance_office_rules',
  'attendance_offices',
  'attendance_setup_progress',
  'attendance_settings',
];

/** Remove append-only audit rows that point at the probe's companies/people. */
export async function deleteAuditRows(
  tenantIds: string[],
  userIds: string[],
): Promise<void> {
  const client = new Client({
    connectionString: process.env['DATABASE_URL'],
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    await client.query(
      `delete from public.audit_log
        where tenant_id = any($1::uuid[])
           or actor_user_id = any($2::uuid[])
           or target_user_id = any($2::uuid[])`,
      [tenantIds, userIds],
    );
    await client.query('commit');
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    await client.end();
  }
}

/** Delete one probe company and its people, in FK-safe order. Idempotent. */
export async function purgeCompany(
  service: SupabaseClient,
  tenantId: string,
  userIds: string[],
): Promise<void> {
  for (const table of TENANT_TABLES) {
    const { error } = await service
      .from(table)
      .delete()
      .eq('tenant_id', tenantId);
    must(`purge ${table}`, error);
  }
  // Rows tied to the people rather than the company.
  must(
    'purge notifications by user',
    (await service.from('notifications').delete().in('user_id', userIds)).error,
  );
  await deleteAuditRows([tenantId], userIds);
  must(
    'purge memberships',
    (await service.from('memberships').delete().eq('tenant_id', tenantId))
      .error,
  );
  must(
    'purge people memberships',
    (await service.from('memberships').delete().in('user_id', userIds)).error,
  );
  must(
    'purge tenant',
    (await service.from('tenants').delete().eq('id', tenantId)).error,
  );
  must(
    'purge users',
    (await service.from('users').delete().in('id', userIds)).error,
  );
}

/**
 * Seed one company. Pre-cleans first so a crashed earlier run cannot block
 * it. `createdBy` is the tenant's creator (must be one of `people`).
 */
export async function seedCompany(
  service: SupabaseClient,
  spec: {
    tenantId: string;
    companyName: string;
    createdBy: string;
    people: SeedPerson[];
  },
): Promise<void> {
  const ids = spec.people.map((p) => p.id);
  await purgeCompany(service, spec.tenantId, ids);

  must(
    'seed users',
    (
      await service.from('users').insert(
        spec.people.map((p) => ({
          id: p.id,
          country_code: '+91',
          phone_number: p.phone,
        })),
      )
    ).error,
  );
  must(
    'seed tenant',
    (
      await service.from('tenants').insert({
        id: spec.tenantId,
        created_by: spec.createdBy,
        company_name: spec.companyName,
        state_code: 'KA',
      })
    ).error,
  );
  const members = spec.people.filter((p) => p.role !== null);
  if (members.length > 0) {
    must(
      'seed memberships',
      (
        await service.from('memberships').insert(
          members.map((p) => ({
            user_id: p.id,
            tenant_id: spec.tenantId,
            role: p.role,
            status: p.status ?? 'active',
          })),
        )
      ).error,
    );
  }
}
