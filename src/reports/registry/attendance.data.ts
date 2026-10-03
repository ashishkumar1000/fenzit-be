import { BadRequestException } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ErrorCode } from '../../common/enums/error-code.enum';
import type { ReportFetchContext } from './report-definition';
import {
  readDayStatusGrid,
  type DayGridRow,
} from '../../common/day-status/grid-reader';
import {
  attendanceOutcome,
  computeAttendanceExceptions,
  registerCode,
  summariseAttendanceRange,
  type AttendanceException,
  type AttendanceSummary,
} from './attendance.metrics';

/**
 * Data fetcher for the Attendance Report (21-2).
 *
 * Two data paths, both tenant-scoped:
 *  - the SHARED day-status grid through `readDayStatusGrid` on the
 *    pipeline's pg transaction client (ctx.pg) — the same function the
 *    attendance routes, Epic 19 aggregates and corrections service use, so
 *    report numbers are parity-locked to the app by construction;
 *  - admin-Supabase reads for everything the grid does not carry (tenant
 *    identity, roster names, office names, rejected punch attempts),
 *    paginated like the job-report fetcher (NFR5: no feature-module
 *    imports).
 *
 * Scope semantics (spec): employee_ids empty = every employee with an
 * enrolment overlapping the range; office_ids filter PER DAY — an employee
 * may count under different offices within one range (effective-dated
 * assignments; the grid row's ctx.officeId snapshot is the attribution).
 */

export interface AttendanceScope {
  allOffices: boolean;
  allEmployees: boolean;
  /** Counts of the EXPLICIT selection (0 when the "all" arm runs). */
  selectedOffices: number;
  selectedEmployees: number;
  /** Resolved in-scope employee count (the roster arm's real size). */
  employeesInScope: number;
  /** Day-register rendering gate: the range length only when ≤ 31 days. */
  registerDays: number | null;
}

export interface AttendanceOfficeRow {
  /** Snapshot office id from the grid rows; null = no covering assignment. */
  id: string | null;
  name: string;
  employees: number;
  summary: AttendanceSummary;
}

export interface AttendanceEmployeeRow {
  id: string;
  name: string;
  /** Distinct office names over the tracked days (effective-dated). */
  offices: string;
  /** First tracked date when it sits inside the range (mid-period join). */
  enrolledFrom: string | null;
  summary: AttendanceSummary;
}

export interface AttendanceWeekRow {
  label: string;
  summary: AttendanceSummary;
}

export interface AttendanceRejectionRow {
  employeeId: string;
  employeeName: string;
  tooFar: number;
  lowAccuracy: number;
  mocked: number;
  rateLimited: number;
  other: number;
}

export interface AttendanceRegister {
  dates: string[];
  rows: { name: string; codes: string[] }[];
}

/** Everything the template needs — pre-aggregated; the template does zero math. */
export interface AttendanceReportData {
  tenant: { companyName: string };
  range: { startDate: string; endDate: string; days: number };
  scope: AttendanceScope;
  overall: AttendanceSummary;
  offices: AttendanceOfficeRow[];
  employees: AttendanceEmployeeRow[];
  exceptions: AttendanceException[];
  weeks: AttendanceWeekRow[];
  register: AttendanceRegister | null;
  rejections: AttendanceRejectionRow[];
}

const PAGE_SIZE = 1000;
const IN_CHUNK_SIZE = 500;
/** report-content.md: the day register renders only for ranges ≤ 31 days. */
const REGISTER_MAX_DAYS = 31;
/** The exceptions list caps here; the template adds the "+N more" line. */
export const EXCEPTIONS_RENDER_CAP = 200;

const IST_OFFSET_SUFFIX = '+05:30';

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** IST day bounds for the inclusive [start_date, end_date] window. */
function istDayBounds(
  startDate: string,
  endDate: string,
): { startIso: string; endExclusiveIso: string } {
  const start = new Date(`${startDate}T00:00:00${IST_OFFSET_SUFFIX}`);
  const endExclusive = new Date(
    new Date(`${endDate}T00:00:00${IST_OFFSET_SUFFIX}`).getTime() + 86_400_000,
  );
  return { startIso: start.toISOString(), endExclusiveIso: endExclusive.toISOString() };
}

/** Inclusive day count of a validated range. */
function daysInclusive(startDate: string, endDate: string): number {
  return (
    (Date.parse(endDate) - Date.parse(startDate)) / 86_400_000 + 1
  );
}

/** "1 Sep" from YYYY-MM-DD. */
function shortDate(isoDate: string): string {
  return `${Number(isoDate.slice(8, 10))} ${MONTHS[Number(isoDate.slice(5, 7)) - 1]}`;
}

/** "1–7 Sep" — the en dash survives a month crossing ("28 Sep – 4 Oct"). */
function weekLabel(start: string, end: string): string {
  return `${shortDate(start)} – ${shortDate(end)}`;
}

function tooLarge(): BadRequestException {
  return new BadRequestException({
    error_code: ErrorCode.REPORT_TOO_LARGE,
    message: 'Report range contains too many employee-days',
  });
}

/** Paged `.in(id-chunk)` read that collects every row past the 1000 cap. */
async function fetchInChunks<T>(
  supabase: SupabaseClient,
  table: string,
  columns: string,
  chunkIds: string[],
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < chunkIds.length; i += IN_CHUNK_SIZE) {
    const chunk = chunkIds.slice(i, i + IN_CHUNK_SIZE);
    let pageFrom = 0;
    for (;;) {
      const { data, error } = await supabase
        .from(table)
        .select(columns)
        .in('id', chunk)
        // Offset pagination needs a stable sort or concurrent writes can
        // skew pages (skips/dupes).
        .order('id')
        .range(pageFrom, pageFrom + PAGE_SIZE - 1);
      if (error) {
        throw new Error(`Failed to fetch ${table} for report: ${error.message}`);
      }
      out.push(...((data ?? []) as T[]));
      if (!data || data.length < PAGE_SIZE) break;
      pageFrom += PAGE_SIZE;
    }
  }
  return out;
}

async function fetchTenantName(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<string> {
  const { data, error } = await supabase
    .from('tenants')
    .select('company_name')
    .eq('id', tenantId)
    .single<{ company_name: string }>();
  if (error || !data) {
    throw new Error(`Failed to fetch tenant for report: ${error?.message}`);
  }
  return data.company_name;
}

/** Employees with an enrolment overlapping the range (the "all employees" arm). */
async function fetchEnrolledEmployeeIds(
  supabase: SupabaseClient,
  tenantId: string,
  startDate: string,
  endDate: string,
): Promise<string[]> {
  const ids = new Set<string>();
  let pageFrom = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('attendance_enrolments')
      .select('employee_id, id')
      .eq('tenant_id', tenantId)
      // daterange overlap — the enrolment covers ≥1 day of the report range.
      .filter('valid', 'ov', `[${startDate},${endDate}]`)
      .order('id')
      .range(pageFrom, pageFrom + PAGE_SIZE - 1);
    if (error) {
      throw new Error(`Failed to fetch enrolments for report: ${error.message}`);
    }
    for (const row of data ?? []) ids.add(row.employee_id);
    if (!data || data.length < PAGE_SIZE) break;
    pageFrom += PAGE_SIZE;
  }
  return [...ids];
}

async function fetchEmployeeNames(
  supabase: SupabaseClient,
  employeeIds: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const rows = await fetchInChunks<{ id: string; name: string }>(
    supabase,
    'users',
    'id, name',
    employeeIds,
  );
  for (const row of rows) names.set(row.id, row.name);
  return names;
}

/** One office row per distinct snapshot office in the filtered grid. */
function buildOfficeRows(
  rows: DayGridRow[],
): AttendanceOfficeRow[] {
  const byOffice = new Map<string | null, DayGridRow[]>();
  for (const row of rows) {
    const key = row.ctx.officeId;
    const list = byOffice.get(key) ?? [];
    list.push(row);
    byOffice.set(key, list);
  }
  const out: AttendanceOfficeRow[] = [];
  for (const [officeId, officeRows] of byOffice) {
    out.push({
      id: officeId,
      name: officeRows[0]?.ctx.officeName ?? '(no office)',
      employees: new Set(officeRows.map((r) => r.employeeId)).size,
      summary: summariseAttendanceRange(officeRows),
    });
  }
  return out.sort((a, b) => {
    if (a.id === null) return 1;
    if (b.id === null) return -1;
    return a.name.localeCompare(b.name);
  });
}

/** 7-day chunks from the range start; the tail keeps its remainder. */
function enumerateWeeks(startDate: string, endDate: string): {
  label: string;
  start: string;
  end: string;
}[] {
  const weeks: { label: string; start: string; end: string }[] = [];
  let cursor = startDate;
  while (cursor <= endDate) {
    const endMs = Math.min(
      Date.parse(cursor) + 6 * 86_400_000,
      Date.parse(endDate),
    );
    const end = new Date(endMs).toISOString().slice(0, 10);
    weeks.push({ label: weekLabel(cursor, end), start: cursor, end });
    cursor = new Date(endMs + 86_400_000).toISOString().slice(0, 10);
  }
  return weeks;
}

/** Rejected punch attempts (any non-ok outcome) bucketed per employee. */
async function fetchRejections(
  supabase: SupabaseClient,
  tenantId: string,
  employeeIds: string[],
  bounds: { startIso: string; endExclusiveIso: string },
  names: Map<string, string>,
): Promise<AttendanceRejectionRow[]> {
  const buckets = new Map<
    string,
    { tooFar: number; lowAccuracy: number; mocked: number; rateLimited: number; other: number }
  >();
  for (let i = 0; i < employeeIds.length; i += IN_CHUNK_SIZE) {
    const chunk = employeeIds.slice(i, i + IN_CHUNK_SIZE);
    let pageFrom = 0;
    for (;;) {
      const { data, error } = await supabase
        .from('attendance_attempts')
        .select('employee_id, outcome')
        .eq('tenant_id', tenantId)
        .in('employee_id', chunk)
        .neq('outcome', 'ok')
        .gte('attempted_at', bounds.startIso)
        .lt('attempted_at', bounds.endExclusiveIso)
        .order('id')
        .range(pageFrom, pageFrom + PAGE_SIZE - 1);
      if (error) {
        throw new Error(`Failed to fetch attempts for report: ${error.message}`);
      }
      for (const row of data ?? []) {
        const b =
          buckets.get(row.employee_id) ??
          { tooFar: 0, lowAccuracy: 0, mocked: 0, rateLimited: 0, other: 0 };
        if (row.outcome === 'too_far') b.tooFar += 1;
        else if (row.outcome === 'low_accuracy') b.lowAccuracy += 1;
        else if (row.outcome === 'mocked') b.mocked += 1;
        else if (row.outcome === 'rate_limited') b.rateLimited += 1;
        else b.other += 1;
        buckets.set(row.employee_id, b);
      }
      if (!data || data.length < PAGE_SIZE) break;
      pageFrom += PAGE_SIZE;
    }
  }
  return [...buckets.entries()]
    .map(([employeeId, b]) => ({
      employeeId,
      employeeName: names.get(employeeId) ?? employeeId,
      ...b,
    }))
    .sort((a, b) => a.employeeName.localeCompare(b.employeeName));
}

export async function fetchAttendanceReportData(
  ctx: ReportFetchContext,
): Promise<AttendanceReportData> {
  const { supabase, params, maxRows } = ctx;
  const { start_date: startDate, end_date: endDate } = params;
  const days = daysInclusive(startDate, endDate);

  const [companyName, enrolledIds] = await Promise.all([
    fetchTenantName(supabase, ctx.tenantId),
    params.technician_ids.length > 0
      ? Promise.resolve([...params.technician_ids])
      : fetchEnrolledEmployeeIds(supabase, ctx.tenantId, startDate, endDate),
  ]);

  const employeeIds = enrolledIds.sort();
  const employeeNames = await fetchEmployeeNames(supabase, employeeIds);

  // Oversize guard BEFORE any grid read: the grid enumerates exactly
  // employeeIds × days rows, so this estimate is the real row count.
  if (employeeIds.length * days > maxRows) {
    throw tooLarge();
  }

  // The parity-critical read — the SAME grid reader the app uses.
  const grid = await readDayStatusGrid(
    ctx.pg,
    ctx.tenantId,
    employeeIds,
    startDate,
    endDate,
  );

  // Office filter applies PER DAY (effective-dated attribution), not per
  // employee — an employee working 2 days in each of 2 selected offices
  // contributes both days' rows.
  const officeSet = new Set(params.office_ids);
  const rows =
    officeSet.size > 0
      ? grid.filter((r) => r.ctx.officeId !== null && officeSet.has(r.ctx.officeId))
      : grid;

  // Explicitly selected employees with zero in-scope days still get a row
  // (an explicit ask gets an explicit answer); the roster arm drops them.
  const explicit = new Set(params.technician_ids);
  const withRows = new Set(rows.map((r) => r.employeeId));
  const summaryIds = employeeIds.filter(
    (id) => withRows.has(id) || explicit.has(id),
  );

  const rowsByEmployee = new Map<string, DayGridRow[]>();
  for (const row of rows) {
    const list = rowsByEmployee.get(row.employeeId) ?? [];
    list.push(row);
    rowsByEmployee.set(row.employeeId, list);
  }
  // Unfiltered per-employee rows: the enrolledFrom annotation reads the
  // employee's real tracked history, not the office filter's slice (a
  // mid-range office move is not a mid-period join).
  const unfilteredByEmployee = new Map<string, DayGridRow[]>();
  for (const row of grid) {
    const list = unfilteredByEmployee.get(row.employeeId) ?? [];
    list.push(row);
    unfilteredByEmployee.set(row.employeeId, list);
  }

  const employees: AttendanceEmployeeRow[] = summaryIds
    .map((id) => {
      const empRows = rowsByEmployee.get(id) ?? [];
      const tracked = (unfilteredByEmployee.get(id) ?? [])
        .filter((r) => r.ctx.tracked)
        .map((r) => r.workDate)
        .sort();
      const officeNames = [
        ...new Set(
          empRows
            .filter((r) => r.ctx.tracked && r.ctx.officeName)
            .map((r) => r.ctx.officeName as string),
        ),
      ];
      return {
        id,
        name: employeeNames.get(id) ?? id,
        offices: officeNames.join(', ') || '—',
        enrolledFrom:
          tracked.length > 0 && tracked[0] > startDate ? tracked[0] : null,
        summary: summariseAttendanceRange(empRows),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const overall = summariseAttendanceRange(rows);
  const offices = buildOfficeRows(rows);

  const weeks = enumerateWeeks(startDate, endDate).map((w) => {
    const weekRows = rows.filter(
      (r) => r.workDate >= w.start && r.workDate <= w.end,
    );
    return { label: w.label, summary: summariseAttendanceRange(weekRows) };
  });

  // Day register — only for short ranges (92-column portrait is unreadable).
  const register =
    days <= REGISTER_MAX_DAYS
      ? {
          dates: Array.from({ length: days }, (_, i) =>
            new Date(Date.parse(startDate) + i * 86_400_000)
              .toISOString()
              .slice(0, 10),
          ),
          rows: employees.map((e) => {
            const empRows = rowsByEmployee.get(e.id) ?? [];
            const outcomeByDate = new Map(
              empRows.map((r) => [r.workDate, attendanceOutcome(r)]),
            );
            return {
              name: e.name,
              codes: Array.from({ length: days }, (_, i) => {
                const date = new Date(Date.parse(startDate) + i * 86_400_000)
                  .toISOString()
                  .slice(0, 10);
                const outcome = outcomeByDate.get(date);
                return outcome ? registerCode(outcome.status) : '·';
              }),
            };
          }),
        }
      : null;

  const exceptions = computeAttendanceExceptions(
    rows,
    new Map(employees.map((e) => [e.id, { name: e.name }])),
  );

  // The audit covers the report's IN-SCOPE employees only — an
  // office-filtered report must not surface out-of-office rejections, and
  // it never widens back to the roster when nobody matches the filter
  // (the template renders the honest empty page then). Audit ⊆ shown
  // employees, always. (QA bug bash 2026-10-03.)
  const rejections = await fetchRejections(
    supabase,
    ctx.tenantId,
    summaryIds,
    istDayBounds(startDate, endDate),
    employeeNames,
  );

  return {
    tenant: { companyName },
    range: { startDate, endDate, days },
    scope: {
      allOffices: params.office_ids.length === 0,
      allEmployees: params.technician_ids.length === 0,
      selectedOffices: params.office_ids.length,
      selectedEmployees: params.technician_ids.length,
      employeesInScope: withRows.size,
      registerDays: days <= REGISTER_MAX_DAYS ? days : null,
    },
    overall,
    offices,
    employees,
    exceptions,
    weeks,
    register,
    rejections,
  };
}
