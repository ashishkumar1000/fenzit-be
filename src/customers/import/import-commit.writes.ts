import { Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CommitRowResult } from './import-commit.types';
import {
  ImportRowReason,
  ImportRowResult,
  ImportRowValues,
  reasonFor,
} from './import-rows.types';

const logger = new Logger('ImportCommitWrites');

/**
 * Columns an import may set on an existing customer. Phone is never here, so
 * a phone match can never change it. A blank cell is null after validation
 * and is left out, so it never clears a stored value.
 */
function fieldsTheRowFills(
  values: ImportRowValues,
  addressChanged: boolean,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const set = (column: string, value: unknown) => {
    if (value !== null) patch[column] = value;
  };
  set('name', values.name);
  set('address', values.address);
  set('city', values.city);
  set('state', values.state);
  set('pincode', values.pincode);
  set('address_details', values.addressDetails);
  // Validation makes lat and lng both set or both blank, so this is a pair.
  if (values.latitude !== null && values.longitude !== null) {
    patch.latitude = values.latitude;
    patch.longitude = values.longitude;
  } else if (addressChanged) {
    // The stored pin belongs to the old address. Blank coordinates still never
    // clear a stored value, except this one: a pin for the wrong place sends a
    // technician to the wrong door, so it is cleared and the staff member
    // fetches the location again.
    patch.latitude = null;
    patch.longitude = null;
  }
  return patch;
}

/**
 * True when the row sets an address that differs from the stored one. A blank
 * address never counts as a change. Null when the stored row cannot be read.
 */
async function addressChangedFor(
  admin: SupabaseClient,
  tenantId: string,
  row: ImportRowResult,
  customerId: string,
): Promise<boolean | null> {
  const address = row.normalised.address;
  if (address === null) return false;
  const { data, error } = await admin
    .from('customers')
    .select('address')
    .eq('id', customerId)
    .eq('tenant_id', tenantId)
    .maybeSingle<{ address: string | null }>();
  if (error || !data) return null;
  return (data.address ?? '') !== address;
}

function failedRow(rowIndex: number, reason: ImportRowReason): CommitRowResult {
  return { rowIndex, status: 'failed', customerId: null, reasons: [reason] };
}

/** Maps a DB error to a plain row reason. Logs the code only, never values. */
function reasonForInsertError(
  rowIndex: number,
  code: string | undefined,
): ImportRowReason {
  logger.warn(
    `Import row not inserted (row=${rowIndex}, code=${code ?? 'none'})`,
  );
  if (code === '23505') return reasonFor('phone', 'PHONE_TAKEN_DURING_IMPORT');
  if (code === '23503') return reasonFor('phone', 'PHONE_UNKNOWN_COUNTRY_CODE');
  return reasonFor('row', 'ROW_SAVE_FAILED');
}

async function insertNew(
  admin: SupabaseClient,
  tenantId: string,
  row: ImportRowResult,
): Promise<CommitRowResult> {
  const v = row.normalised;
  const { data, error } = await admin
    .from('customers')
    .insert({
      id: crypto.randomUUID(),
      tenant_id: tenantId,
      name: v.name,
      country_code: v.countryCode,
      phone_number: v.phoneNumber,
      address: v.address,
      city: v.city,
      state: v.state,
      pincode: v.pincode,
      latitude: v.latitude,
      longitude: v.longitude,
      address_details: v.addressDetails,
      created_via: 'bulk_import',
    })
    .select('id')
    .single<{ id: string }>();
  if (error) {
    return failedRow(
      row.rowIndex,
      reasonForInsertError(row.rowIndex, error.code),
    );
  }
  return {
    rowIndex: row.rowIndex,
    status: 'created',
    customerId: data.id,
    reasons: [],
  };
}

async function updateExisting(
  admin: SupabaseClient,
  tenantId: string,
  row: ImportRowResult,
  customerId: string,
): Promise<CommitRowResult> {
  const changed = await addressChangedFor(admin, tenantId, row, customerId);
  if (changed === null) {
    logger.warn(`Import row not updated (row=${row.rowIndex}, code=read)`);
    return failedRow(row.rowIndex, reasonFor('row', 'ROW_SAVE_FAILED'));
  }
  // tenant_id in the filter: a row can only ever touch its own company.
  const { data, error } = await admin
    .from('customers')
    .update(fieldsTheRowFills(row.normalised, changed))
    .eq('id', customerId)
    .eq('tenant_id', tenantId)
    .select('id')
    .maybeSingle();
  if (error || !data) {
    logger.warn(
      `Import row not updated (row=${row.rowIndex}, code=${error?.code ?? 'none'})`,
    );
    return failedRow(row.rowIndex, reasonFor('row', 'ROW_SAVE_FAILED'));
  }
  return {
    rowIndex: row.rowIndex,
    status: 'updated',
    customerId,
    reasons: [],
  };
}

/**
 * Writes one valid row on its own. A phone already in this company updates
 * that customer (only the fields the row fills). Any other valid row inserts
 * a new customer tagged created_via = bulk_import. Never throws: a failed
 * row becomes a `failed` result so the other rows still save.
 */
export async function writeImportRow(
  admin: SupabaseClient,
  tenantId: string,
  row: ImportRowResult,
): Promise<CommitRowResult> {
  try {
    if (row.existingCustomerId) {
      return await updateExisting(admin, tenantId, row, row.existingCustomerId);
    }
    return await insertNew(admin, tenantId, row);
  } catch {
    // A network fault rejects instead of returning an error. Log the row
    // number only: the thrown message can echo values from the row.
    logger.warn(`Import row write threw (row=${row.rowIndex})`);
    return failedRow(row.rowIndex, reasonFor('row', 'ROW_SAVE_FAILED'));
  }
}
