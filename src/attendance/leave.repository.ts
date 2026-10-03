import type { PoolClient } from 'pg';
import {
  ACTIVE_LEAVE_STATES,
  DERIVED_STATUS_ORDER,
  type DerivedLeaveStatus,
  type LeaveDayState,
  PG_OVERLAP_CONSTRAINT,
  PG_REQUEST_KEY_CONSTRAINT,
} from './leave.constants';
import type { LeaveDayRow, LeaveRequestRow } from './leave.model';
import { WeeklyOffRow } from './me-summary.model';

/**
 * Every SQL statement for the leave lifecycle (17-1..17-4) — parameterised,
 * tenant/employee-scoped, running inside the caller's transaction (the
 * 15-7/16-1 pattern; NO new SQL functions beyond the guard trigger,
 * AD-3 amendment). Array parameters in date predicates carry an explicit
 * `::date[]` cast (node-postgres cannot infer them server-side — the 16-1
 * corrective-apply lesson).
 */

export interface LeaveRequestWithDays {
  request: LeaveRequestRow;
  days: LeaveDayRow[];
}

function mapRequest(row: unknown): LeaveRequestRow {
  return row as LeaveRequestRow;
}

/**
 * Creates the request row. Maps a raced UNIQUE by CONSTRAINT NAME (spec
 * D7): `leave_requests_tenant_request_uq` → 'duplicate_key' (another
 * employee burned this idempotency key), `leave_request_days_active_uq`
 * surfaces from the day INSERT instead. Any other 23505 rethrows.
 */
export async function insertLeaveRequest(
  tx: PoolClient,
  input: {
    tenantId: string;
    employeeId: string;
    requestId: string;
    startDate: string;
    endDate: string;
    part: string;
    reason: string;
    createdBy: string;
  },
): Promise<LeaveRequestRow | 'duplicate_key'> {
  try {
    const result = await tx.query<LeaveRequestRow>(
      `insert into public.leave_requests
         (tenant_id, employee_id, request_id, start_date, end_date, part, reason, created_by)
       values ($1::uuid, $2::uuid, $3::uuid, $4::date, $5::date, $6::text, $7::text, $8::uuid)
       returning id, tenant_id, employee_id, request_id, start_date::text,
                 end_date::text, part, reason, created_by, created_at`,
      [
        input.tenantId,
        input.employeeId,
        input.requestId,
        input.startDate,
        input.endDate,
        input.part,
        input.reason,
        input.createdBy,
      ],
    );
    return mapRequest(result.rows[0]);
  } catch (err) {
    if (
      (err as { code?: string; constraint?: string }).code === '23505' &&
      (err as { constraint?: string }).constraint === PG_REQUEST_KEY_CONSTRAINT
    ) {
      return 'duplicate_key';
    }
    throw err;
  }
}

/** The request's own id for an existing idempotency key (replay path). */
export async function findRequestIdByKey(
  tx: PoolClient,
  tenantId: string,
  requestId: string,
  callerId: string,
): Promise<LeaveRequestRow | null> {
  // Caller-scoped (spec D7): for self-apply the caller is the employee;
  // for on-behalf the caller is the creating owner. Another caller
  // presenting a burned key must neither read it nor be blocked by it.
  const result = await tx.query<LeaveRequestRow>(
    `select id, tenant_id, employee_id, request_id, start_date::text,
            end_date::text, part, reason, created_by, created_at
     from public.leave_requests
     where tenant_id = $1 and request_id = $2
       and (employee_id = $3::uuid or created_by = $3::uuid)
     limit 1`,
    [tenantId, requestId, callerId],
  );
  const row = result.rows[0];
  return row ? mapRequest(row) : null;
}

export async function findRequestWithDays(
  tx: PoolClient,
  tenantId: string,
  leaveRequestDbId: string,
  employeeId?: string,
): Promise<LeaveRequestWithDays | null> {
  const request = await tx.query<LeaveRequestRow>(
    `select id, tenant_id, employee_id, request_id, start_date::text,
            end_date::text, part, reason, created_by, created_at
     from public.leave_requests
     where tenant_id = $1::uuid and id = $2::uuid
       ${employeeId ? 'and employee_id = $3::uuid' : ''}`,
    employeeId
      ? [tenantId, leaveRequestDbId, employeeId]
      : [tenantId, leaveRequestDbId],
  );
  const row = request.rows[0];
  if (!row) return null;
  const days = await tx.query<LeaveDayRow>(
    `select leave_date::text, state
     from public.leave_request_days
     where leave_request_id = $1
     order by leave_date`,
    [row.id],
  );
  return { request: mapRequest(row), days: days.rows };
}

/**
 * The overlap probe (the friendly pre-check; the partial unique index is
 * the race backstop). Active (pending/approved) days of the employee
 * inside the proposed span, with their request ids.
 */
export async function findOverlappingDays(
  tx: PoolClient,
  tenantId: string,
  employeeId: string,
  startDate: string,
  endDate: string,
): Promise<LeaveDayRow[]> {
  const result = await tx.query<LeaveDayRow>(
    `select d.leave_date::text, d.state
     from public.leave_request_days d
     where d.tenant_id = $1::uuid and d.employee_id = $2::uuid
       and d.leave_date between $3::date and $4::date
       and d.state = any($5::text[])
     order by d.leave_date
     limit 1`,
    [tenantId, employeeId, startDate, endDate, ACTIVE_LEAVE_STATES],
  );
  return result.rows;
}

/** Past-or-today dates in the span that already have an attendance record.
 * `today` is the TENANT-local date (AD-7) — never current_date, whose UTC
 * day silently diverges from the tenant's between local midnight and the
 * UTC midnight boundary (three-reviewer finding). */
export async function findCheckedInDates(
  tx: PoolClient,
  tenantId: string,
  employeeId: string,
  startDate: string,
  endDate: string,
  today: string,
): Promise<string[]> {
  const result = await tx.query<{ work_date: string }>(
    `select work_date::text
     from public.attendance_records
     where tenant_id = $1::uuid and employee_id = $2::uuid
       and work_date between $3::date and least($4::date, $5::date)
     order by work_date`,
    [tenantId, employeeId, startDate, endDate, today],
  );
  return result.rows.map((r) => r.work_date);
}

export interface SpanDayFacts {
  date: string;
  isWorkingDay: boolean;
  kind: 'working' | 'weekly_off' | 'holiday';
}

/**
 * Pure span-fact computation shared by the single-employee read and the
 * page batch — one implementation, no drift. The pickers validity-check
 * each row per date, so a superset of override/default rows is harmless.
 */
function computeSpanFacts(
  dates: string[],
  overrides: WeeklyOffRow[],
  defaults: WeeklyOffRow[],
  holidayDates: string[],
  pickWeeklyOffDays: (
    overrides: WeeklyOffRow[],
    defaults: WeeklyOffRow[],
    anchor: string,
  ) => number[],
  isoWeekdayOf: (date: string) => number,
): Map<string, SpanDayFacts> {
  const holidaySet = new Set(holidayDates);
  const facts = new Map<string, SpanDayFacts>();
  for (const date of dates) {
    const isHoliday = holidaySet.has(date);
    const weeklyOffDays = pickWeeklyOffDays(overrides, defaults, date);
    const isWeeklyOff = weeklyOffDays.includes(isoWeekdayOf(date));
    facts.set(date, {
      date,
      isWorkingDay: !isWeeklyOff && !isHoliday,
      kind: isHoliday ? 'holiday' : isWeeklyOff ? 'weekly_off' : 'working',
    });
  }
  return facts;
}

/**
 * Per-date working/off facts across a span: the weekly-off override
 * REPLACES the default and holidays win over weekly offs (FR-10 rule 4
 * order, the same pickers me/summary and the day context use — one
 * implementation, no drift).
 */
export async function readSpanFacts(
  tx: PoolClient,
  tenantId: string,
  employeeId: string,
  dates: string[],
  pickWeeklyOffDays: (
    overrides: WeeklyOffRow[],
    defaults: WeeklyOffRow[],
    anchor: string,
  ) => number[],
  isoWeekdayOf: (date: string) => number,
): Promise<Map<string, SpanDayFacts>> {
  const [overrides, defaults, holidays] = await Promise.all([
    tx.query<WeeklyOffRow>(
      `select valid::text, days from public.attendance_weekly_off_overrides
       where employee_id = $1::uuid and valid && $2::daterange`,
      [employeeId, `[${dates[0]},${dates[dates.length - 1]}]`],
    ),
    tx.query<WeeklyOffRow>(
      `select valid::text, days from public.attendance_weekly_off_defaults
       where tenant_id = $1::uuid and valid && $2::daterange`,
      [tenantId, `[${dates[0]},${dates[dates.length - 1]}]`],
    ),
    tx.query<{ holiday_date: string }>(
      `select holiday_date::text from public.holidays
       where tenant_id = $1::uuid and holiday_date between $2::date and $3::date`,
      [tenantId, dates[0], dates[dates.length - 1]],
    ),
  ]);
  return computeSpanFacts(
    dates,
    overrides.rows,
    defaults.rows,
    holidays.rows.map((r) => r.holiday_date),
    pickWeeklyOffDays,
    isoWeekdayOf,
  );
}

/** One request span on a list page: whose calendar, which dates. */
export interface PageSpan {
  employeeId: string;
  dates: string[];
}

/**
 * The whole LIST PAGE's span facts in 3 statements (overrides for every
 * page employee, tenant defaults, tenant holidays — union date range).
 * The list loop once awaited readSpanFacts per row: 3 round trips × rows,
 * strictly sequential (one tx connection cannot pipeline) ≈ 17s for a
 * 20-row page on the pooler — past the client's 15s timeout. Batching
 * bounds the page at 3 round trips regardless of row count; the facts are
 * computed in JS with the SAME pickers, so results are identical.
 * Returns employeeId → (date → facts). The per-employee maps are SHARED
 * across every request row of that employee — treat them as read-only.
 */
export async function readPageSpanFacts(
  tx: PoolClient,
  tenantId: string,
  spans: PageSpan[],
  pickWeeklyOffDays: (
    overrides: WeeklyOffRow[],
    defaults: WeeklyOffRow[],
    anchor: string,
  ) => number[],
  isoWeekdayOf: (date: string) => number,
): Promise<Map<string, Map<string, SpanDayFacts>>> {
  if (spans.length === 0) return new Map();
  const dated = spans.filter((s) => s.dates.length > 0);
  if (dated.length === 0) return new Map();
  const employeeIds = [...new Set(dated.map((s) => s.employeeId))].sort();
  // The union range comes from a flat sort — no assumption that any
  // caller's per-span dates arrive ascending.
  const allDates = dated.flatMap((s) => s.dates).sort();
  const rangeStart = allDates[0];
  const rangeEnd = allDates[allDates.length - 1];
  const range = `[${rangeStart},${rangeEnd}]`;
  const [overrides, defaults, holidays] = await Promise.all([
    tx.query<WeeklyOffRow & { employee_id: string }>(
      `select employee_id, valid::text, days from public.attendance_weekly_off_overrides
       where employee_id = any($1::uuid[]) and valid && $2::daterange`,
      [employeeIds, range],
    ),
    tx.query<WeeklyOffRow>(
      `select valid::text, days from public.attendance_weekly_off_defaults
       where tenant_id = $1::uuid and valid && $2::daterange`,
      [tenantId, range],
    ),
    tx.query<{ holiday_date: string }>(
      `select holiday_date::text from public.holidays
       where tenant_id = $1::uuid and holiday_date between $2::date and $3::date`,
      [tenantId, rangeStart, rangeEnd],
    ),
  ]);
  const overridesByEmployee = new Map<string, WeeklyOffRow[]>();
  for (const { employee_id, ...rest } of overrides.rows) {
    const list = overridesByEmployee.get(employee_id) ?? [];
    list.push(rest);
    overridesByEmployee.set(employee_id, list);
  }
  // Several requests of one employee merge into one ascending date list.
  const datesByEmployee = new Map<string, string[]>();
  for (const span of dated) {
    const dates = datesByEmployee.get(span.employeeId);
    if (dates) {
      for (const date of span.dates) {
        if (!dates.includes(date)) dates.push(date);
      }
    } else {
      datesByEmployee.set(span.employeeId, [...span.dates]);
    }
  }
  const holidayDates = holidays.rows.map((r) => r.holiday_date);
  const factsByEmployee = new Map<string, Map<string, SpanDayFacts>>();
  for (const [employeeId, dates] of datesByEmployee) {
    dates.sort();
    factsByEmployee.set(
      employeeId,
      computeSpanFacts(
        dates,
        overridesByEmployee.get(employeeId) ?? [],
        defaults.rows,
        holidayDates,
        pickWeeklyOffDays,
        isoWeekdayOf,
      ),
    );
  }
  return factsByEmployee;
}

/**
 * D9 floor + gate facts in one read: the enrolment start covering today
 * (the tracking start — the same anchoring the 15-9 access view uses),
 * else the earliest enrolment start (an upcoming employee's future start).
 * `lower()` of an unbounded range is NULL on PG17, hence the filters.
 */
export async function readEnrolmentFloor(
  tx: PoolClient,
  employeeId: string,
  today: string,
): Promise<{ exists: boolean; floor: string | null; coversToday: boolean }> {
  const result = await tx.query<{ start: string; covers: boolean }>(
    `select lower(valid)::text as start, (valid @> $2::date) as covers
     from public.attendance_enrolments
     where employee_id = $1::uuid
       and lower(valid) is not null and lower(valid) <> '-infinity'
     order by lower(valid)`,
    [employeeId, today],
  );
  const rows = result.rows;
  const covering = rows.filter((r) => r.covers);
  // Not covering today (upcoming, or disabled-then-re-enabled): the floor
  // is the earliest FUTURE start — an ended past enrolment must neither
  // gate the employee out nor lower the floor (review finding).
  const floor =
    covering.length > 0
      ? covering[0].start
      : (rows.find((r) => r.start > today)?.start ?? rows[0]?.start ?? null);
  return { exists: rows.length > 0, floor, coversToday: covering.length > 0 };
}

/** Settings gate: setup completed AND module enabled (the kill switch). */
export async function readSettingsGate(
  tx: PoolClient,
  tenantId: string,
): Promise<{ setupCompleted: boolean; enabled: boolean }> {
  const result = await tx.query<{
    setup_completed_at: Date | string | null;
    enabled: boolean;
  }>(
    `select setup_completed_at, enabled from public.attendance_settings
     where tenant_id = $1::uuid`,
    [tenantId],
  );
  const row = result.rows[0];
  return {
    setupCompleted: row?.setup_completed_at != null,
    enabled: row?.enabled === true,
  };
}

/**
 * D10: the on-behalf target must be a user of THIS tenant — checked before
 * any validation so a foreign id answers 404 (no existence leak, no gate
 * noise about a person who was never here).
 */
export async function employeeExistsInTenant(
  tx: PoolClient,
  tenantId: string,
  employeeId: string,
): Promise<boolean> {
  const result = await tx.query<{ n: string }>(
    `select count(*)::text as n from public.users
     where tenant_id = $1::uuid and id = $2::uuid and role = 'technician'`,
    [tenantId, employeeId],
  );
  return Number(result.rows[0]?.n ?? 0) > 0;
}

/** The active day rows of one request in the given source states. */
export async function findDaysInStates(
  tx: PoolClient,
  leaveRequestDbId: string,
  states: LeaveDayState[],
): Promise<LeaveDayRow[]> {
  const result = await tx.query<LeaveDayRow>(
    `select leave_date::text, state
     from public.leave_request_days
     where leave_request_id = $1::uuid and state = any($2::text[])
     order by leave_date`,
    [leaveRequestDbId, states],
  );
  return result.rows;
}

/** D7: the last audit event for the request — seq ordering, not uuid/now(). */
export async function findLastEvent(
  tx: PoolClient,
  leaveRequestDbId: string,
): Promise<{ cause: string; actorId: string | null } | null> {
  const result = await tx.query<{ cause: string; actor_id: string | null }>(
    `select cause, actor_id
     from public.leave_events
     where leave_request_id = $1::uuid
     order by seq desc
     limit 1`,
    [leaveRequestDbId],
  );
  const row = result.rows[0];
  return row ? { cause: row.cause, actorId: row.actor_id } : null;
}

/** tenants.owner_id — the recipient for owner-facing leave events. */
export async function readOwnerId(
  tx: PoolClient,
  tenantId: string,
): Promise<string | null> {
  const result = await tx.query<{ owner_id: string }>(
    'select owner_id from public.tenants where id = $1::uuid',
    [tenantId],
  );
  return result.rows[0]?.owner_id ?? null;
}

/** Employee display name for payloads (nullable — never blocks the write). */
export async function readEmployeeName(
  tx: PoolClient,
  tenantId: string,
  employeeId: string,
): Promise<string | null> {
  const result = await tx.query<{ name: string }>(
    'select name from public.users where tenant_id = $1::uuid and id = $2::uuid',
    [tenantId, employeeId],
  );
  return result.rows[0]?.name ?? null;
}

/**
 * D13: the derived-status SQL CASE, GENERATED from DERIVED_STATUS_ORDER —
 * the same array the model derives with, so `?status=` can never disagree
 * with the displayed status (the parity the repository unit test pins).
 */
export function derivedStatusSql(): string {
  const branches = DERIVED_STATUS_ORDER.map(
    (state) => `when bool_or(state = '${state}') then '${state}'`,
  ).join('\n    ');
  return `case
    ${branches}
    else 'rejected'
  end`;
}

export interface LeaveListRow extends LeaveRequestRow {
  employee_name: string | null;
  derived_status: DerivedLeaveStatus;
}

/**
 * One list page (owner or me). Keyset paging under (created_at DESC,
 * id DESC) on the OUTER query — the derived-status subquery never changes
 * the keyset shape (house customers.service pattern).
 */
export async function listLeaveRequests(
  tx: PoolClient,
  input: {
    tenantId: string;
    employeeId?: string;
    status?: DerivedLeaveStatus;
    cursorCreatedAt?: string;
    cursorId?: string;
    limit: number;
  },
): Promise<LeaveListRow[]> {
  const statusCase = derivedStatusSql();
  const conditions = ['r.tenant_id = $1::uuid'];
  const params: unknown[] = [input.tenantId];
  if (input.employeeId) {
    params.push(input.employeeId);
    conditions.push(`r.employee_id = $${params.length}::uuid`);
  }
  if (input.status) {
    params.push(input.status);
    conditions.push(`s.derived_status = $${params.length}::text`);
  }
  if (input.cursorCreatedAt && input.cursorId) {
    params.push(input.cursorCreatedAt, input.cursorId);
    conditions.push(
      `(r.created_at, r.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
    );
  }
  params.push(input.limit + 1);
  const result = await tx.query<LeaveListRow>(
    `select r.id, r.tenant_id, r.employee_id, r.request_id, r.start_date::text,
            r.end_date::text, r.part, r.reason, r.created_by, r.created_at,
            u.name as employee_name,
            s.derived_status
     from public.leave_requests r
     join (
       select leave_request_id, ${statusCase} as derived_status
       from public.leave_request_days
       group by leave_request_id
     ) s on s.leave_request_id = r.id
     left join public.users u on u.id = r.employee_id
     where ${conditions.join(' and ')}
     order by r.created_at desc, r.id desc
     limit $${params.length}`,
    params,
  );
  return result.rows;
}

/** Day rows for a page of requests (batched; the view builder groups them). */
export async function findDaysForRequests(
  tx: PoolClient,
  requestIds: string[],
): Promise<Map<string, LeaveDayRow[]>> {
  const map = new Map<string, LeaveDayRow[]>();
  if (requestIds.length === 0) return map;
  const result = await tx.query<LeaveDayRow & { leave_request_id: string }>(
    `select leave_request_id, leave_date::text, state
     from public.leave_request_days
     where leave_request_id = any($1::uuid[])
     order by leave_date`,
    [requestIds],
  );
  for (const row of result.rows) {
    const list = map.get(row.leave_request_id) ?? [];
    list.push({ leave_date: row.leave_date, state: row.state });
    map.set(row.leave_request_id, list);
  }
  return map;
}

/**
 * The D12 disable sweep source: pending days (ALL of them — AD-23's
 * "pending" is unqualified) and approved days from `effectiveFrom`, for
 * every request of the employee.
 */
export async function findDaysForDisableSweep(
  tx: PoolClient,
  tenantId: string,
  employeeId: string,
  effectiveFrom: string,
): Promise<
  {
    requestId: string;
    requestKey: string;
    startDate: string;
    endDate: string;
    pending: string[];
    approved: string[];
  }[]
> {
  const result = await tx.query<{
    id: string;
    request_id: string;
    start_date: string;
    end_date: string;
    pending: string[] | null;
    approved: string[] | null;
  }>(
    `select r.id, r.request_id, r.start_date::text, r.end_date::text,
            array_agg(d.leave_date::text) filter (where d.state = 'pending') as pending,
            array_agg(d.leave_date::text) filter (where d.state = 'approved'
                                                    and d.leave_date >= $3::date) as approved
     from public.leave_requests r
     join public.leave_request_days d on d.leave_request_id = r.id
     where r.tenant_id = $1::uuid and r.employee_id = $2::uuid
       and (d.state = 'pending' or (d.state = 'approved' and d.leave_date >= $3::date))
     group by r.id
     order by r.created_at`,
    [tenantId, employeeId, effectiveFrom],
  );
  return result.rows.map((row) => ({
    requestId: row.id,
    requestKey: row.request_id,
    startDate: row.start_date,
    endDate: row.end_date,
    pending: row.pending ?? [],
    approved: row.approved ?? [],
  }));
}

/**
 * Today's ACTIVE leave row for the day context (D3): at most one exists —
 * the partial unique index admits no second pending/approved row. The
 * request ids ride along for FR-9's auto-cancel transition.
 */
export async function findActiveLeaveForDate(
  tx: PoolClient,
  employeeId: string,
  workDate: string,
): Promise<{
  state: 'pending' | 'approved';
  part: string;
  leaveRequestDbId: string;
  requestId: string;
} | null> {
  const result = await tx.query<{
    state: 'pending' | 'approved';
    part: string;
    leave_request_db_id: string;
    request_id: string;
  }>(
    `select d.state, r.part, r.id as leave_request_db_id, r.request_id
     from public.leave_request_days d
     join public.leave_requests r on r.id = d.leave_request_id
     where d.employee_id = $1::uuid and d.leave_date = $2::date
       and d.state in ('pending','approved')
     limit 1`,
    [employeeId, workDate],
  );
  const row = result.rows[0];
  return row
    ? {
        state: row.state,
        part: row.part,
        leaveRequestDbId: row.leave_request_db_id,
        requestId: row.request_id,
      }
    : null;
}
