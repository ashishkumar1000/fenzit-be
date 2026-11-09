import type { SupabaseClient } from '@supabase/supabase-js';

/** Days a new company gets before its subscription ends (CAP-3). */
export const NEW_COMPANY_VALIDITY_DAYS = 90;

/**
 * Sets the company's subscription end to 90 days from now, but only when no
 * date is set yet. Called by the application right after a company is
 * created, so the new-company rule lives in code, not in a database trigger.
 * Idempotent: a repeat setup call never moves an existing date. Throws on a
 * database error, so the caller can fail the setup and the owner can retry.
 */
export async function startCompanyValidity(
  admin: SupabaseClient,
  tenantId: string,
  now: Date = new Date(),
): Promise<void> {
  const validityUntil = new Date(
    now.getTime() + NEW_COMPANY_VALIDITY_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const { error } = await admin
    .from('tenants')
    .update({ validity_until: validityUntil, updated_at: now.toISOString() })
    .eq('id', tenantId)
    .is('validity_until', null);
  if (error) throw error;
}
