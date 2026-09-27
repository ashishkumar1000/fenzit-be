import { Logger } from '@nestjs/common';
import { WeeklyOffRow } from './weekly-offs-response.model';
import { Admin, internalError } from './attendance-rpc.helpers';

const logger = new Logger('WeeklyOffsRepository');

/**
 * Admin-client reads for the weekly-off routes (15-5). Extracted from
 * weekly-offs.service at the review so the service stays under the ~300
 * -line rule; every read carries an explicit tenant_id filter (RLS is
 * deny-by-default on these tables — the admin client is the only writer).
 */

/** users row fields the override list reads (admin client — RLS bypassed). */
interface EmployeeRow {
  id: string;
  name: string | null;
  country_code: string | null;
  phone_number: string | null;
}

/** All the tenant's default ranges (fetch-and-pick happens in the model). */
export async function readDefaults(
  admin: Admin,
  tenantId: string,
): Promise<WeeklyOffRow[]> {
  const { data, error } = await admin
    .from('attendance_weekly_off_defaults')
    .select('*')
    .eq('tenant_id', tenantId);
  if (error) {
    throw internalError('Failed to read weekly offs');
  }
  return data ?? [];
}

/** The tenant's override ranges, optionally narrowed to one employee. */
export async function readOverrides(
  admin: Admin,
  tenantId: string,
  employeeId?: string,
): Promise<WeeklyOffRow[]> {
  let query = admin
    .from('attendance_weekly_off_overrides')
    .select('*')
    .eq('tenant_id', tenantId);
  if (employeeId) {
    query = query.eq('employee_id', employeeId);
  }
  const { data, error } = await query;
  if (error) {
    throw internalError('Failed to read weekly-off overrides');
  }
  return data ?? [];
}

/** id → display name for the override views (admin client, tenant filter). */
export async function readEmployeeNames(
  admin: Admin,
  tenantId: string,
  employeeIds: string[],
): Promise<Map<string, string>> {
  if (employeeIds.length === 0) {
    return new Map();
  }
  const { data, error } = await admin
    .from('users')
    .select('id, name, country_code, phone_number')
    .eq('tenant_id', tenantId)
    .in('id', employeeIds);
  if (error) {
    // The failure is in the users read — name the message accordingly (the
    // review: the thrown message misattributed it to the overrides table).
    throw internalError('Failed to read employee names');
  }
  const names = new Map<string, string>();
  for (const row of (data ?? []) as EmployeeRow[]) {
    // Same display fallback as the RPCs (20260927000003): name, then the
    // reassembled E.164 number (users.phone was split long ago). The dial
    // code already carries its '+' — country_codes.dial_code is FK-enforced
    // and stores '+91', so no prefix is added here.
    names.set(
      row.id,
      row.name ||
        `${row.country_code ?? ''}${row.phone_number ?? ''}` ||
        'Unknown employee',
    );
  }
  return names;
}
