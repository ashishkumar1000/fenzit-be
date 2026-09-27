import { Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { Admin, internalError } from './attendance-rpc.helpers';
import { AccessStateRow, EnrolmentRow } from './enrolments-response.model';

const logger = new Logger('EnrolmentsRepository');

/**
 * SQL for the enrolment lifecycle (15-7). Every write function receives the
 * open transaction client from `PgPoolFactory.withTransaction` — the AD-8
 * plan's steps only hold together (and against the deferrable coverage
 * trigger) inside the one transaction. All queries are parameterised.
 * Reads of the `attendance_access_state` view go through the admin client
 * elsewhere; this repository owns the transactional half only.
 */

/** pg error shape (SQLSTATE in `code`, RAISE … USING HINT in `hint`). */
export interface PgError {
  code?: string;
  hint?: string;
  message: string;
}

/** Shared tenant lock, same key the RPCs use — AD-5, one lock space. */
export async function lockTenantShared(
  tx: PoolClient,
  tenantId: string,
): Promise<void> {
  await tx.query('select public.attendance_lock_tenant($1, false)', [
    tenantId,
  ]);
}

/** The only source of "today" (AD-7); raises PT404/HINT for unknown tenants. */
export async function tenantToday(tx: PoolClient, tenantId: string): Promise<string> {
  const result = await tx.query<{ today: string }>(
    'select public.attendance_today($1)::text as today',
    [tenantId],
  );
  const today = result.rows[0]?.today;
  if (!today || !/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    // A contract-breaking value would corrupt every downstream date
    // comparison (review finding) — fail loud here, not with a NaN Date.
    throw internalError('Failed to resolve tenant date');
  }
  return today;
}

export async function readEmployee(
  tx: PoolClient,
  tenantId: string,
  employeeId: string,
): Promise<{ id: string; name: string | null } | null> {
  const result = await tx.query<{ id: string; name: string | null }>(
    'select id, name from public.users where id = $1 and tenant_id = $2',
    [employeeId, tenantId],
  );
  return result.rows[0] ?? null;
}

export async function readOffice(
  tx: PoolClient,
  tenantId: string,
  officeId: string,
): Promise<{ id: string; name: string; archived_at: string | null }> {
  const result = await tx.query<{
    id: string;
    name: string;
    archived_at: string | null;
  }>(
    `select id, name, archived_at from public.attendance_offices
     where id = $1 and tenant_id = $2`,
    [officeId, tenantId],
  );
  const office = result.rows[0];
  if (!office) {
    const err = new Error(`office ${officeId} not found in tenant ${tenantId}`) as PgError;
    err.code = 'PT404';
    err.hint = 'ATTENDANCE_OFFICE_NOT_FOUND';
    throw err;
  }
  return office;
}

/** Epic 16's table — probed, never assumed (the FR-6 rule self-activates). */
export async function attendanceRecordsExist(tx: PoolClient): Promise<boolean> {
  const result = await tx.query<{ reg: string | null }>(
    'select to_regclass($1)::text as reg',
    ['public.attendance_records'],
  );
  return result.rows[0]?.reg != null;
}

export async function hasCheckInOn(
  tx: PoolClient,
  employeeId: string,
  workDate: string,
): Promise<boolean> {
  const result = await tx.query(
    `select 1 from public.attendance_records
     where employee_id = $1 and work_date = $2 limit 1`,
    [employeeId, workDate],
  );
  return result.rows.length > 0;
}

export async function readEnrolments(
  tx: PoolClient,
  employeeId: string,
): Promise<EnrolmentRow[]> {
  const result = await tx.query<EnrolmentRow>(
    'select id, valid::text, enabled_at::text from public.attendance_enrolments where employee_id = $1',
    [employeeId],
  );
  return result.rows;
}

export async function readAssignments(
  tx: PoolClient,
  employeeId: string,
): Promise<EnrolmentRow[]> {
  const result = await tx.query<EnrolmentRow>(
    'select id, valid::text from public.attendance_office_assignments where employee_id = $1',
    [employeeId],
  );
  return result.rows;
}

export async function deleteRanges(
  tx: PoolClient,
  table: 'attendance_enrolments' | 'attendance_office_assignments',
  ids: string[],
): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  await tx.query(
    `delete from public.${table} where id = any($1::uuid[])`,
    [ids],
  );
}

export async function clipRangeEnd(
  tx: PoolClient,
  table: 'attendance_enrolments' | 'attendance_office_assignments',
  id: string,
  newEnd: string,
): Promise<void> {
  await tx.query(
    `update public.${table} set valid = daterange(lower(valid), $2::date, '[)')
     where id = $1`,
    [id, newEnd],
  );
}

export async function insertEnrolment(
  tx: PoolClient,
  tenantId: string,
  employeeId: string,
  start: string,
): Promise<void> {
  await tx.query(
    `insert into public.attendance_enrolments (tenant_id, employee_id, valid)
     values ($1, $2, daterange($3::date, null, '[)'))`,
    [tenantId, employeeId, start],
  );
}

export async function insertAssignment(
  tx: PoolClient,
  tenantId: string,
  employeeId: string,
  officeId: string,
  start: string,
): Promise<void> {
  await tx.query(
    `insert into public.attendance_office_assignments (tenant_id, employee_id, office_id, valid)
     values ($1, $2, $3, daterange($4::date, null, '[)'))`,
    [tenantId, employeeId, officeId, start],
  );
}

/**
 * Post-write read of the employee's access state (the AD-17 view). Called
 * inside the transaction so the response reflects the committed write; a
 * coverage-trigger rejection has already aborted everything by then.
 */
export async function readAccessState(
  tx: PoolClient,
  tenantId: string,
  userId: string,
): Promise<AccessStateRow> {
  const result = await tx.query<{
    user_id: string;
    tenant_id: string;
    attendance_enabled: boolean;
    access_state: AccessStateRow['access_state'];
    attendance_start_date: string;
    enabled_at: Date;
    onboarded_at: Date | null;
    office_id: string | null;
    office_name: string | null;
  }>(
    `select user_id, tenant_id, attendance_enabled, access_state,
            attendance_start_date::text, enabled_at, onboarded_at,
            office_id::text, office_name
     from public.attendance_access_state
     where user_id = $1 and tenant_id = $2`,
    [userId, tenantId],
  );
  const row = result.rows[0];
  if (!row) {
    // The view is user-keyed over users; a missing row means the view
    // contract broke — fail loud, never return a fabricated state.
    logger.error('attendance_access_state returned no row', { userId, tenantId });
    throw internalError('Failed to read access state');
  }
  // pg hands timestamptz back as a Date — normalise to ISO-8601 (AD-7) so
  // the pg-pool responses match the admin-client view reads byte for byte.
  return {
    ...row,
    enabled_at: row.enabled_at ? new Date(row.enabled_at).toISOString() : null,
    onboarded_at: row.onboarded_at ? new Date(row.onboarded_at).toISOString() : null,
  };
}

/**
 * Upsert-once record of FR-4 onboarding (first write wins). The ignored
 * upsert returns no rows on a replay, so the row is read back separately —
 * a replay answers with the ORIGINAL onboarded_at, never an error.
 */
export async function markOnboarded(
  admin: Admin,
  tenantId: string,
  employeeId: string,
): Promise<string | null> {
  const { error: upsertError } = await admin
    .from('attendance_onboarding')
    .upsert(
      { employee_id: employeeId, tenant_id: tenantId },
      { onConflict: 'employee_id', ignoreDuplicates: true },
    );
  if (upsertError) {
    logger.error('Failed to mark onboarding:', { error: upsertError });
    throw internalError('Failed to record onboarding');
  }

  const { data, error } = await admin
    .from('attendance_onboarding')
    .select('onboarded_at')
    .eq('employee_id', employeeId)
    .single<{ onboarded_at: string }>();
  if (error || !data) {
    logger.error('Failed to read onboarding record:', { error });
    throw internalError('Failed to record onboarding');
  }
  return data.onboarded_at;
}
