import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The FIXED four-type catalog (23-13), seeded at company setup so a new
 * tenant starts with the same catalog the migration ensured for the ones
 * that predate it. Idempotent by design: the upsert rides the
 * (tenant_id, code) unique and ignores duplicates, so a retry after a
 * failed setup heals any missing rows (the repeat setup call lands here
 * too — the RPC reports created=false but the catalog is guaranteed all
 * the same). Zero RPCs — a plain table write.
 */
const FIXED_CATALOG = [
  {
    name: 'Earned Leave',
    code: 'earned',
    accrual_mode: 'monthly',
    accrual_days: 1,
    carry_forward: true,
  },
  {
    name: 'Sick Leave',
    code: 'sick',
    accrual_mode: 'monthly',
    accrual_days: 0.5,
    carry_forward: false,
  },
  {
    name: 'Bereavement',
    code: 'bereavement',
    accrual_mode: 'annual',
    accrual_days: 0,
    carry_forward: false,
  },
  {
    name: 'Comp-Off',
    code: 'comp_off',
    accrual_mode: 'none',
    accrual_days: 0,
    carry_forward: false,
  },
];

export async function seedLeaveCatalog(
  admin: SupabaseClient<any, any, 'public', any, any>,
  tenantId: string,
): Promise<void> {
  const { error } = await admin.from('leave_types').upsert(
    FIXED_CATALOG.map((t) => ({
      tenant_id: tenantId,
      ...t,
      paid: true,
      enabled: true,
    })),
    { onConflict: 'tenant_id,code', ignoreDuplicates: true },
  );
  if (error) {
    throw new Error(`the leave catalog could not be seeded: ${error.message}`);
  }
}
