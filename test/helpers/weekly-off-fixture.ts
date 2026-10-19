import { Pool } from 'pg';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';

/** Shared real-DB plumbing for the weekly-off suites (throwaway tenants). */

const DATABASE_URL = process.env['DATABASE_URL'] ?? '';
const SUPABASE_URL = process.env['SUPABASE_URL'] ?? '';
const SUPABASE_SERVICE_KEY =
  process.env['SUPABASE_SERVICE_ROLE_KEY'] ??
  process.env['SUPABASE_SERVICE_KEY'] ??
  '';

export const IS_REAL_DB =
  DATABASE_URL.includes('@') &&
  SUPABASE_URL.startsWith('https://') &&
  !SUPABASE_URL.startsWith('https://test.supabase.co') &&
  SUPABASE_SERVICE_KEY !== '';

/**
 * Call inside a `describe`. With REQUIRE_REAL_DB=1 and no real database it
 * makes the suite FAIL (a beforeAll that throws, plus one always-run test so
 * an all-`it.skip` suite cannot hide it). Without the flag it does nothing,
 * and the specs skip as before.
 */
export function requireRealDbWhenAsked(): void {
  if (process.env['REQUIRE_REAL_DB'] !== '1' || IS_REAL_DB) return;
  const msg =
    'REQUIRE_REAL_DB=1 but no real database is configured (DATABASE_URL, SUPABASE_URL, service key)';
  beforeAll(() => {
    throw new Error(msg);
  });
  it('requires a real database', () => {
    throw new Error(msg);
  });
}

/** The protected production-like tenant these suites must never touch. */
export const PROTECTED_TENANT = '4586040a-daea-496c-b9e8-16c8f1f97539';

/** Unwrap a MUST-succeed supabase call. */
export function must<T>(res: {
  data: T | null;
  error: { message: string } | null;
}): T {
  if (res.error) throw new Error(`fixture failed: ${res.error.message}`);
  return res.data as T;
}

export interface Crew {
  tenant: string;
  owner: string;
  staff: string[];
}

export interface Fixture {
  pool: Pool;
  admin: SupabaseClient;
  crews: Crew[];
}

/** Unique 10-digit local number: a fixed leading 7 plus 9 random digits. */
const usedPhones = new Set<string>();
const phone = (): string => {
  for (;;) {
    const p = `7${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
    if (!usedPhones.has(p)) {
      usedPhones.add(p);
      return p;
    }
  }
};

export function openClients(): { pool: Pool; admin: SupabaseClient } {
  return {
    pool: new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 2,
    }),
    admin: createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    }),
  };
}

/**
 * One throwaway tenant: an owner plus `staffCount` active technicians. If a
 * later insert fails, the rows already inserted are removed before rethrowing.
 */
export async function createCrew(
  admin: SupabaseClient,
  staffCount: number,
  tz = 'Asia/Kolkata',
): Promise<Crew> {
  const tenant = randomUUID();
  const owner = randomUUID();
  const staff = Array.from({ length: staffCount }, () => randomUUID());
  try {
    must(
      await admin.from('users').insert({
        id: owner,
        role: 'owner',
        status: 'active',
        country_code: '+91',
        phone_number: phone(),
        name: 'wo owner',
      }),
    );
    if (staff.length) {
      must(
        await admin.from('users').insert(
          staff.map((id, i) => ({
            id,
            role: 'technician',
            status: 'active',
            country_code: '+91',
            phone_number: phone(),
            name: `wo staff ${i + 1}`,
          })),
        ),
      );
    }
    must(
      await admin.from('tenants').insert({
        id: tenant,
        owner_id: owner,
        company_name: `wo probe ${tenant.slice(0, 8)}`,
        state_code: 'KA',
        timezone: tz,
      }),
    );
    must(
      await admin
        .from('users')
        .update({ tenant_id: tenant })
        .in('id', [owner, ...staff]),
    );
    must(
      await admin.from('attendance_settings').insert({
        tenant_id: tenant,
        enabled: true,
        setup_completed_at: new Date().toISOString(),
      }),
    );
  } catch (err) {
    try {
      await removeCrew(admin, { tenant, owner, staff });
    } catch {
      // best effort: the original failure is the one worth reporting
    }
    throw err;
  }
  return { tenant, owner, staff };
}

/**
 * FK-safe teardown of one crew. Tries every delete, then throws one error
 * listing all that failed (so a leak is never silent).
 */
export async function removeCrew(
  admin: SupabaseClient,
  crew: Crew,
): Promise<void> {
  if (crew.tenant === PROTECTED_TENANT) throw new Error('protected tenant');
  const steps: [string, PromiseLike<{ error: { message: string } | null }>][] =
    [
      [
        'overrides',
        admin
          .from('attendance_weekly_off_overrides')
          .delete()
          .eq('tenant_id', crew.tenant),
      ],
      [
        'defaults',
        admin
          .from('attendance_weekly_off_defaults')
          .delete()
          .eq('tenant_id', crew.tenant),
      ],
      [
        'settings',
        admin.from('attendance_settings').delete().eq('tenant_id', crew.tenant),
      ],
      ['tenant', admin.from('tenants').delete().eq('id', crew.tenant)],
    ];
  const failures: string[] = [];
  for (const [name, q] of steps) {
    const { error } = await q;
    if (error) failures.push(`${name}: ${error.message}`);
  }
  const del = await admin
    .from('users')
    .delete()
    .in('id', [crew.owner, ...crew.staff]);
  if (del.error) failures.push(`users: ${del.error.message}`);
  if (failures.length) {
    throw new Error(`teardown leak (${crew.tenant}): ${failures.join('; ')}`);
  }
}

/** Remove every crew that exists (skips undefined), then throw all failures at once. */
export async function removeCrews(
  admin: SupabaseClient,
  crews: (Crew | undefined)[],
): Promise<void> {
  const errs: string[] = [];
  for (const c of crews) {
    if (!c) continue;
    try {
      await removeCrew(admin, c);
    } catch (e) {
      errs.push((e as Error).message);
    }
  }
  if (errs.length) throw new Error(errs.join(' | '));
}

/**
 * Reset between tests: delete each crew's default rules (and override rules
 * when asked) and clear the configured marker. Any failure throws.
 */
export async function resetWeeklyOff(
  admin: SupabaseClient,
  crews: Crew[],
  withOverrides = false,
): Promise<void> {
  for (const c of crews) {
    if (withOverrides) {
      must(
        await admin
          .from('attendance_weekly_off_overrides')
          .delete()
          .eq('tenant_id', c.tenant),
      );
    }
    must(
      await admin
        .from('attendance_weekly_off_defaults')
        .delete()
        .eq('tenant_id', c.tenant),
    );
    must(
      await admin
        .from('tenants')
        .update({ weekly_off_configured_at: null })
        .eq('id', c.tenant),
    );
  }
}

export * from './weekly-off-queries';
