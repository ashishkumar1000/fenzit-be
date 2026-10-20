import { Pool } from 'pg';

/** Read/seed helpers for the weekly-off suites (re-exported by the fixture). */

/** The tenant's own "today" (attendance_today), as YYYY-MM-DD. */
export async function tenantToday(pool: Pool, tenant: string): Promise<string> {
  const r = await pool.query<{ d: string }>(
    'select public.attendance_today($1)::text as d',
    [tenant],
  );
  return r.rows[0].d;
}

/** today + n days, as YYYY-MM-DD (pure UTC calendar maths). */
export function addDays(date: string, n: number): string {
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/** [from, to|null, days] as day-offsets from `today` — easy to read in asserts. */
export type Span = [number, number | null, number[]];

const OFFSET_SQL = `
  lower(valid) - $2::date as f,
  case when upper(valid) is null then null else upper(valid) - $2::date end as t,
  days`;

async function spans(
  pool: Pool,
  table: string,
  keyCol: string,
  key: string,
  today: string,
): Promise<Span[]> {
  const r = await pool.query<{ f: number; t: number | null; days: number[] }>(
    `select ${OFFSET_SQL} from public.${table} where ${keyCol} = $1 order by lower(valid)`,
    [key, today],
  );
  return r.rows.map((x) => [x.f, x.t, x.days]);
}

export const defaultSpans = (pool: Pool, tenant: string, today: string) =>
  spans(pool, 'attendance_weekly_off_defaults', 'tenant_id', tenant, today);

export const overrideSpans = (pool: Pool, employee: string, today: string) =>
  spans(
    pool,
    'attendance_weekly_off_overrides',
    'employee_id',
    employee,
    today,
  );

/**
 * Invariant: no two ranges of one tenant (defaults) / employee (overrides)
 * overlap — scoped to the given throwaway tenants only.
 */
export async function overlapCount(
  pool: Pool,
  tenants: string[],
): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `select (
       (select count(*) from public.attendance_weekly_off_defaults a
          join public.attendance_weekly_off_defaults b
            on a.tenant_id = b.tenant_id and a.id < b.id and a.valid && b.valid
         where a.tenant_id = any($1::uuid[]))
     + (select count(*) from public.attendance_weekly_off_overrides a
          join public.attendance_weekly_off_overrides b
            on a.employee_id = b.employee_id and a.id < b.id and a.valid && b.valid
         where a.tenant_id = any($1::uuid[]))
     )::text as n`,
    [tenants],
  );
  return Number(r.rows[0].n);
}

/** Seed a rule row directly (the RPCs clamp to today, so the past needs raw SQL). */
export async function seedDefault(
  pool: Pool,
  tenant: string,
  today: string,
  from: number,
  to: number | null,
  days: number[],
): Promise<void> {
  if (to !== null && to <= from) {
    throw new Error(`seedDefault: empty range (from ${from}, to ${to})`);
  }
  await pool.query(
    `insert into public.attendance_weekly_off_defaults (tenant_id, valid, days)
     values ($1, daterange($2::date + $3::int, case when $4::int is null then null else $2::date + $4::int end, '[)'), $5)`,
    [tenant, today, from, to, days],
  );
}
