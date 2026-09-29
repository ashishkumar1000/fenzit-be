import type { PoolClient } from 'pg';

/**
 * Every SQL statement for the corrections writes/reads (Epic 18, 18-2) —
 * parameterised, tenant/employee-scoped, running inside the caller's
 * transaction (the 15-7/16-1/17-1 pattern; NO new SQL functions, AD-3
 * amendment). The override is UPSERTed against
 * `attendance_day_overrides_empdate_uq`: DO UPDATE resets `deleted_at` to
 * null, so a re-created correction on a previously removed date un-deletes
 * the same physical row (the composite FK from the audit's
 * `(employee_id, work_date)` stays valid on every path — no hard delete
 * anywhere). `attendance_records` is NEVER touched here (AD-12).
 */

export interface OverrideRowFull {
  id: string;
  status: string | null;
  manual_checkin_at: Date | string | null;
  manual_checkout_at: Date | string | null;
  deleted_at: Date | string | null;
  created_by: string;
}

/** One active (not soft-deleted) override for the employee-date, else null. */
export async function findActiveOverride(
  tx: PoolClient,
  tenantId: string,
  employeeId: string,
  workDate: string,
): Promise<OverrideRowFull | null> {
  const result = await tx.query<OverrideRowFull>(
    `select id, status, manual_checkin_at, manual_checkout_at, deleted_at, created_by
     from public.attendance_day_overrides
     where tenant_id = $1::uuid and employee_id = $2::uuid
       and work_date = $3::date and deleted_at is null
     limit 1`,
    [tenantId, employeeId, workDate],
  );
  return result.rows[0] ?? null;
}

/**
 * The upsert-and-undelete write: fields not in the new value are reset to
 * null so the row always carries exactly one arm (status XOR times) — a
 * later status-only correction clears the manual instants of the previous
 * times-only one (D4: "full current value replaces the previous one").
 */
export async function upsertOverride(
  tx: PoolClient,
  input: {
    tenantId: string;
    employeeId: string;
    workDate: string;
    status: string | null;
    manualCheckinAt: string | null;
    manualCheckoutAt: string | null;
    createdBy: string;
  },
): Promise<void> {
  await tx.query(
    `insert into public.attendance_day_overrides
       (tenant_id, employee_id, work_date, status, manual_checkin_at,
        manual_checkout_at, created_by)
     values ($1::uuid, $2::uuid, $3::date, $4::text, $5::timestamptz,
             $6::timestamptz, $7::uuid)
     on conflict (employee_id, work_date) do update set
       status = excluded.status,
       manual_checkin_at = excluded.manual_checkin_at,
       manual_checkout_at = excluded.manual_checkout_at,
       deleted_at = null,
       created_by = excluded.created_by,
       updated_at = now()`,
    [
      input.tenantId,
      input.employeeId,
      input.workDate,
      input.status,
      input.manualCheckinAt,
      input.manualCheckoutAt,
      input.createdBy,
    ],
  );
}

/** The day's original record row (old_value seeding; never mutated). */
export async function findOriginalRecordForDate(
  tx: PoolClient,
  tenantId: string,
  employeeId: string,
  workDate: string,
): Promise<{ checkin_at: Date | string } | null> {
  const result = await tx.query<{ checkin_at: Date | string }>(
    `select checkin_at from public.attendance_records
     where tenant_id = $1::uuid and employee_id = $2::uuid
       and work_date = $3::date
     limit 1`,
    [tenantId, employeeId, workDate],
  );
  return result.rows[0] ?? null;
}

/**
 * Appends ONE audit row per correction/removal. `seq` (identity) orders
 * a per-date chain; the row returns `created_at` for correctedAt.
 */
export async function insertCorrection(
  tx: PoolClient,
  input: {
    tenantId: string;
    employeeId: string;
    workDate: string;
    actorId: string;
    oldValue: unknown;
    newValue: unknown;
    note: string;
  },
): Promise<{ id: string; created_at: Date | string }> {
  const result = await tx.query<{ id: string; created_at: Date | string }>(
    `insert into public.attendance_corrections
       (tenant_id, employee_id, work_date, actor_id, note, old_value, new_value)
     values ($1::uuid, $2::uuid, $3::date, $4::uuid, $5::text,
             $6::jsonb, $7::jsonb)
     returning id, created_at`,
    [
      input.tenantId,
      input.employeeId,
      input.workDate,
      input.actorId,
      input.note,
      JSON.stringify(input.oldValue),
      JSON.stringify(input.newValue),
    ],
  );
  return result.rows[0];
}

/** Soft-delete: zero rows = nothing active was removed (own retry). */
export async function softDeleteOverride(
  tx: PoolClient,
  tenantId: string,
  employeeId: string,
  workDate: string,
): Promise<number> {
  const result = await tx.query(
    `update public.attendance_day_overrides
     set deleted_at = now(), updated_at = now()
     where tenant_id = $1::uuid and employee_id = $2::uuid
       and work_date = $3::date and deleted_at is null`,
    [tenantId, employeeId, workDate],
  );
  return result.rowCount ?? 0;
}

/**
 * AD-10 / D5: clears the fake-location marker. The cast order matters —
 * `attempted_at AT TIME ZONE $tz` renders the tenant-local wall time, whose
 * `::date` equals `dateInTz`'s Intl computation (both read the IANA
*tz database). Rows are kept (the dispute view, AD-4).
 */
export async function ackAttempts(
  tx: PoolClient,
  input: {
    tenantId: string;
    employeeId: string;
    workDate: string;
    timezone: string;
  },
): Promise<number> {
  const result = await tx.query(
    `update public.attendance_attempts
     set acknowledged_at = now()
     where tenant_id = $1::uuid and employee_id = $2::uuid
       and outcome = 'mocked' and acknowledged_at is null
       and (attempted_at at time zone $3::text)::date = $4::date`,
    [
      input.tenantId,
      input.employeeId,
      input.timezone,
      input.workDate,
    ],
  );
  return result.rowCount ?? 0;
}

/** One history page (keyset on created_at desc — the 17-1 D13 shape). */
export async function findCorrectionHistory(
  tx: PoolClient,
  input: {
    tenantId: string;
    employeeId?: string;
    workDate?: string;
    cursorCreatedAt?: string;
    cursorId?: string;
    limit: number;
  },
): Promise<
  {
    id: string;
    employee_id: string;
    work_date: string;
    created_at: Date | string;
    note: string;
    old_value: unknown;
    new_value: unknown;
    actor_name: string | null;
  }[]
> {
  const conditions = ['c.tenant_id = $1::uuid'];
  const params: unknown[] = [input.tenantId];
  if (input.employeeId) {
    params.push(input.employeeId);
    conditions.push(`c.employee_id = $${params.length}::uuid`);
  }
  if (input.workDate) {
    params.push(input.workDate);
    conditions.push(`c.work_date = $${params.length}::date`);
  }
  if (input.cursorCreatedAt && input.cursorId) {
    params.push(input.cursorCreatedAt, input.cursorId);
    conditions.push(
      `(c.created_at, c.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
    );
  }
  params.push(input.limit + 1);
  const result = await tx.query<{
    id: string;
    employee_id: string;
    work_date: string;
    created_at: Date | string;
    note: string;
    old_value: unknown;
    new_value: unknown;
    actor_name: string | null;
  }>(
    `select c.id, c.employee_id, c.work_date::text, c.created_at, c.note,
            c.old_value, c.new_value, u.name as actor_name
     from public.attendance_corrections c
     left join public.users u on u.id = c.actor_id
     where ${conditions.join(' and ')}
     order by c.created_at desc, c.id desc
     limit $${params.length}`,
    params,
  );
  return result.rows;
}

/**
 * The leave mirror gate's fact read (D2): dates in `[start, end]` the
 * employee carries a NON-ABSENT override on — a status arm of present /
 * half_day, or a times-only row (a corrected instant proves presence).
 * Only plain `absent` correction rows may sit under approved leave.
 * Returns the dates ordered by `work_date` ASC — the rejection message
 * names the EARLIEST corrected day (review G2-P7 order contract).
 */
export async function findActiveOverrideDates(
  tx: PoolClient,
  input: {
    tenantId: string;
    employeeId: string;
    start: string;
    end: string;
  },
): Promise<string[]> {
  const result = await tx.query<{ work_date: string }>(
    `select work_date::text from public.attendance_day_overrides
     where tenant_id = $1::uuid and employee_id = $2::uuid
       and work_date between $3::date and $4::date
       and deleted_at is null
       and (status in ('present', 'half_day')
            or (status is null
                and (manual_checkin_at is not null
                     or manual_checkout_at is not null)))
     order by work_date asc`,
    [input.tenantId, input.employeeId, input.start, input.end],
  );
  return result.rows.map((r) => r.work_date);
}
