import type { SupabaseClient } from '@supabase/supabase-js';

/** One business type as the app shows it: a stable code and a plain label. */
export interface BusinessTypeItem {
  code: string;
  label: string;
}

interface CatalogRow {
  id: string;
  code: string;
  label: string;
  sort_order: number;
}

interface TenantTypeRow {
  business_types: CatalogRow | CatalogRow[] | null;
}

/** Every active business type, in display order. */
export async function listActiveBusinessTypes(
  admin: SupabaseClient,
): Promise<BusinessTypeItem[]> {
  const { data, error } = await admin
    .from('business_types')
    .select('code, label')
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .returns<BusinessTypeItem[]>();
  if (error) throw error;
  return data ?? [];
}

/** The active business types a company picked, in display order. */
export async function loadTenantBusinessTypes(
  admin: SupabaseClient,
  tenantId: string,
): Promise<BusinessTypeItem[]> {
  const { data, error } = await admin
    .from('tenant_business_types')
    .select('business_types!inner(id, code, label, sort_order, is_active)')
    .eq('tenant_id', tenantId)
    .eq('business_types.is_active', true)
    .returns<TenantTypeRow[]>();
  if (error) throw error;

  const rows = (data ?? []).flatMap((r) =>
    Array.isArray(r.business_types)
      ? r.business_types
      : r.business_types
        ? [r.business_types]
        : [],
  );
  rows.sort((a, b) => a.sort_order - b.sort_order);
  return rows.map((r) => ({ code: r.code, label: r.label }));
}
