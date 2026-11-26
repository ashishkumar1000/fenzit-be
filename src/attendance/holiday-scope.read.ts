import type { PoolClient } from 'pg';
import type { ScopedHoliday } from '../common/day-status/holiday-scope';

/**
 * The SQL half of per-office holiday applicability — the scoped reads every
 * direct `public.holidays` consumer runs. Each statement is a SINGLE
 * parameterised round trip (the office ids arrive as an aggregate), so the
 * batched call shapes the engines already have survive unchanged.
 *
 * Applicability itself is pure (`holidayAppliesToOffice`) — these reads
 * return the rows, never the verdict.
 */

/** A scoped read row: the pure holiday + the date and the console copy. */
export type ScopedHolidayRow = ScopedHoliday & {
  holidayDate: string;
  description: string | null;
};

// The SQL row speaks snake_case (`holiday_date`) — omit the camelCase
// `holidayDate` too, or the phantom inherited field invites a silent
// `undefined` read.
interface ScopedHolidaySqlRow
  extends Omit<ScopedHolidayRow, 'officeIds' | 'holidayDate'> {
  holiday_date: string;
  officeIds: string[] | null;
}

const SCOPED_SELECT = `
  select h.id, h.name, h.scope, h.description, h.holiday_date::text,
         coalesce(
           (select array_agg(ho.office_id::text)
            from public.holiday_offices ho
            where ho.holiday_id = h.id),
           '{}'
         ) as "officeIds"
  from public.holidays h
  where h.tenant_id = $1::uuid`;

/** Every tenant holiday, ascending by date (the existing list contract). */
export async function readScopedHolidays(
  tx: PoolClient,
  tenantId: string,
): Promise<ScopedHolidayRow[]> {
  const { rows } = await tx.query<ScopedHolidaySqlRow>(
    `${SCOPED_SELECT} order by h.holiday_date asc`,
    [tenantId],
  );
  return rows.map(toScoped);
}

/** Holidays in [from, to], ascending by date (empty officeIds when 'all'). */
export async function readScopedHolidaysBetween(
  tx: PoolClient,
  tenantId: string,
  from: string,
  to: string,
): Promise<ScopedHolidayRow[]> {
  const { rows } = await tx.query<ScopedHolidaySqlRow>(
    `${SCOPED_SELECT} and h.holiday_date between $2::date and $3::date
     order by h.holiday_date asc`,
    [tenantId, from, to],
  );
  return rows.map(toScoped);
}

/** The single holiday on a date (unique per tenant+date), or null. */
export async function readScopedHolidayOn(
  tx: PoolClient,
  tenantId: string,
  date: string,
): Promise<ScopedHolidayRow | null> {
  const { rows } = await tx.query<ScopedHolidaySqlRow>(
    `${SCOPED_SELECT} and h.holiday_date = $2::date limit 1`,
    [tenantId, date],
  );
  return rows[0] ? toScoped(rows[0]) : null;
}

/**
 * The employee's office assignments overlapping a range — the other half
 * every per-employee filter needs (covering assignment per date). Ordered,
 * so consumers that pick the first match stay deterministic when one
 * employee holds overlapping assignments.
 */
export async function readAssignmentsOverlapping(
  tx: PoolClient,
  tenantId: string,
  employeeIds: string[],
  from: string,
  to: string,
): Promise<{ employeeId: string; officeId: string; valid: string }[]> {
  const { rows } = await tx.query<{
    employee_id: string;
    office_id: string;
    valid: string;
  }>(
    `select employee_id::text, office_id::text, valid::text
     from public.attendance_office_assignments
     where tenant_id = $1::uuid and employee_id = any($2::uuid[])
       and valid && $3::daterange
     order by employee_id, office_id`,
    [tenantId, employeeIds, `[${from},${to}]`],
  );
  return rows.map((r) => ({
    employeeId: r.employee_id,
    officeId: r.office_id,
    valid: r.valid,
  }));
}

function toScoped(row: ScopedHolidaySqlRow): ScopedHolidayRow {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    scope: row.scope,
    officeIds: row.officeIds ?? [],
    holidayDate: row.holiday_date,
  };
}
