import { ForbiddenException, HttpException, HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PoolClient } from 'pg';
import { PgPoolFactory } from '../common/pg/pg-pool.factory';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { ErrorCode } from '../common/enums/error-code.enum';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { internalError, requireTenant } from './attendance-rpc.helpers';
import { employeeExistsInTenant } from './leave.repository';
import { tenantToday } from './enrolments.repository';
import type { AccessStateRow } from './enrolments-response.model';
import { parseDateRange } from './enrolments-response.model';
import type { OfficeRuleRow, WeeklyOffRow } from './me-summary.model';
import { pickRuleForDate, pickWeeklyOffDays } from './me-summary.model';
import type {
  DayContext,
  DayFacts,
  OfficeJoinRow,
} from './day-context';
import { assembleDayContext } from './day-context';
import {
  computeDayStatus,
  effectiveInstants,
  type DayStatusOutcome,
} from './day-status.model';
import {
  toDayStatusRow,
  type DayStatusRow,
  type DayStatusesResponse,
  type MeDayStatusesResponse,
} from './day-status-response.model';
import { validateCorrectionValue, type LatestCorrectionView } from './correction.model';
import { toTenantOffsetIso } from './check-in-out.model';

/**
 * The day-statuses reads (18-1): the per-employee-date fact grid and the
 * FR-10 engine outcomes over a range, inside ONE transaction. The SQL is
 * the batched shape of day-context.read.ts (AD-22) — the statements all
 * carry a `valid && range` / BETWEEN overlap cut, then assemble per date
 * with the same pickers `me/summary` and the day context use (one
 * implementation; the 15-9 drift class stays closed). No per-date SQL: the
 * 50-employee × 31-day NFR-7 budget rides on the batch even though the
 * owner route admits a single employee (Epic 19 aggregates reuse this
 * exactly).
 *
 * Owner routes verify the employee 404-no-leak (D6). `me` routes run the
 * AD-17 access gate (none → 403; history_only readable).
 */

const logger = new Logger('DayStatusRead');

export const DAY_STATUSES_MAX_SPAN_DAYS = 62;

interface EnrolmentFactRow {
  employee_id: string;
  valid: string;
  enabled_at: Date | string;
}

interface AssignmentRow {
  employee_id: string;
  valid: string;
  office_id: string;
  office_name: string;
  office_lat: number;
  office_lng: number;
  radius_m: number;
}

type RuleRow = OfficeRuleRow & { office_id: string };

/** Exported: the unit specs build real-typed grid rows (no mirror types). */
export interface RecordRow {
  employee_id: string;
  work_date: string;
  checkin_at: Date | string;
  checkout_at: Date | string | null;
}

interface AttemptFactRow {
  employee_id: string;
  attempt_date: string;
  n: string;
}

interface LeaveDayRow {
  employee_id: string;
  leave_date: string;
  state: 'pending' | 'approved';
  part: 'full_day' | 'first_half' | 'second_half';
}

export interface OverrideRow {
  employee_id: string;
  work_date: string;
  status: string | null;
  manual_checkin_at: Date | string | null;
  manual_checkout_at: Date | string | null;
}

interface CorrectionRow {
  employee_id: string;
  work_date: string;
  created_at: Date | string;
  note: string;
  old_value: unknown;
  new_value: unknown;
  actor_name: string | null;
}

/** One assembled employee-date of the grid (the engine input bundle). */
export interface DayGridRow {
  employeeId: string;
  workDate: string;
  today: string;
  ctx: DayContext;
  record: RecordRow | null;
  override: OverrideRow | null;
  hasUnackMockedAttempt: boolean;
  latestCorrection: CorrectionRow | null;
}

/** The D6/D7 range validator (owner + me): the span cap runs BEFORE any
 *  per-date work (the leave-validation DoS lesson). */
export function validateDayStatusRange(
  from: string,
  to: string,
): { ok: false; message: string } | { ok: true } {
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRe.test(from) || !dateRe.test(to)) {
    return { ok: false, message: 'Dates must be in YYYY-MM-DD format' };
  }
  if (to < from) {
    return {
      ok: false,
      message: 'The end date cannot be before the start date',
    };
  }
  const spanDays = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
  if (spanDays > DAY_STATUSES_MAX_SPAN_DAYS) {
    return {
      ok: false,
      message: `A day-status range covers at most ${DAY_STATUSES_MAX_SPAN_DAYS} days`,
    };
  }
  return { ok: true };
}

/** Every date of `[from, to]` inclusive (span-capped upstream). */
function enumerateRange(from: string, to: string): string[] {
  const dates: string[] = [];
  let cursor = from;
  while (cursor <= to) {
    dates.push(cursor);
    const [y, m, d] = cursor.split('-').map(Number);
    cursor = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  }
  return dates;
}

const keyOf = (employeeId: string, date: string): string =>
  `${employeeId}|${date}`;

/**
 * Reads the grid's batched facts (ONE transaction client) and assembles the
 * per-date engine inputs — the queries mirror buildDayContext's shape,
 * generalised from one date to `employeeIds[] × [from, to]`.
 */
export async function readDayStatusGrid(
  tx: PoolClient,
  tenantId: string,
  employeeIds: string[],
  from: string,
  to: string,
): Promise<DayGridRow[]> {
  const today = await tenantToday(tx, tenantId);
  const [timezone, settings, enrolments, assignments, woOverrides, woDefaults, holidays] =
    await Promise.all([
      tx
        .query<{ timezone: string }>(
          'select timezone from public.tenants where id = $1::uuid',
          [tenantId],
        )
        .then((r) => r.rows[0]?.timezone ?? null),
      tx
        .query<{ enabled: boolean; setup_completed_at: Date | string | null }>(
          `select enabled, setup_completed_at from public.attendance_settings
           where tenant_id = $1::uuid`,
          [tenantId],
        )
        .then((r) => r.rows[0] ?? null),
      tx
        .query<EnrolmentFactRow>(
          `select employee_id, valid::text, enabled_at
           from public.attendance_enrolments
           where tenant_id = $1::uuid
             and employee_id = any($2::uuid[]) and valid && $3::daterange`,
          [tenantId, employeeIds, `[${from},${to}]`],
        )
        .then((r) => r.rows),
      tx
        .query<AssignmentRow>(
          `select a.employee_id, a.office_id, a.valid::text, o.name as office_name,
                  o.latitude as office_lat, o.longitude as office_lng, o.radius_m
           from public.attendance_office_assignments a
           join public.attendance_offices o on o.id = a.office_id
           where a.tenant_id = $1::uuid
             and a.employee_id = any($2::uuid[]) and a.valid && $3::daterange`,
          [tenantId, employeeIds, `[${from},${to}]`],
        )
        .then((r) => r.rows),
      tx
        .query<WeeklyOffRow & { employee_id: string }>(
          `select employee_id, valid::text, days
           from public.attendance_weekly_off_overrides
           where tenant_id = $1::uuid
             and employee_id = any($2::uuid[]) and valid && $3::daterange`,
          [tenantId, employeeIds, `[${from},${to}]`],
        )
        .then((r) => r.rows),
      tx
        .query<WeeklyOffRow>(
          `select valid::text, days from public.attendance_weekly_off_defaults
           where tenant_id = $1::uuid and valid && $2::daterange`,
          [tenantId, `[${from},${to}]`],
        )
        .then((r) => r.rows),
      tx
        .query<{ id: string; name: string; holiday_date: string }>(
          `select id, name, holiday_date::text from public.holidays
           where tenant_id = $1::uuid and holiday_date between $2::date and $3::date`,
          [tenantId, from, to],
        )
        .then((r) => r.rows),
    ]);
  if (!timezone) {
    logger.error('Tenant timezone missing', { tenantId });
    throw internalError('Failed to resolve day-status facts');
  }
  const holidayMap = new Map(
    holidays.map((h) => [h.holiday_date, { id: h.id, name: h.name }]),
  );

  // The rules hang off the covering assignment's office — dedupe the IDs.
  const officeIds = [...new Set(assignments.map((row) => row.office_id))];
  const [rules, records, attempts, leaveDays, overrides, corrections] =
    await Promise.all([
      officeIds.length === 0
        ? (Promise.resolve([]) as Promise<RuleRow[]>)
        : tx
            .query<RuleRow>(
              `select office_id, id, valid::text, start_time::text,
                      end_time::text, late_cutoff_minutes,
                      full_day_hours::float8, half_day_hours::float8
               from public.attendance_office_rules
               where office_id = any($1::uuid[]) and valid && $2::daterange`,
              [officeIds, `[${from},${to}]`],
            )
            .then((r) => r.rows),
      tx
        .query<RecordRow>(
          `select employee_id, work_date::text, checkin_at, checkout_at
           from public.attendance_records
           where tenant_id = $1::uuid and employee_id = any($2::uuid[])
             and work_date between $3::date and $4::date`,
          [tenantId, employeeIds, from, to],
        )
        .then((r) => r.rows),
      tx
        .query<AttemptFactRow>(
          `select employee_id,
                  (attempted_at at time zone $2::text)::date::text as attempt_date,
                  count(*)::text as n
           from public.attendance_attempts
           where tenant_id = $1::uuid and employee_id = any($3::uuid[])
             and outcome = 'mocked' and acknowledged_at is null
             and (attempted_at at time zone $2::text)::date between $4 and $5
           group by employee_id, attempt_date`,
          [tenantId, timezone, employeeIds, from, to],
        )
        .then((r) => r.rows),
      tx
        .query<LeaveDayRow>(
          `select d.employee_id, d.leave_date::text, d.state, r.part
           from public.leave_request_days d
           join public.leave_requests r on r.id = d.leave_request_id
           where d.tenant_id = $1::uuid and d.employee_id = any($2::uuid[])
             and d.leave_date between $3::date and $4::date
             and d.state in ('pending','approved')`,
          [tenantId, employeeIds, from, to],
        )
        .then((r) => r.rows),
      tx
        .query<OverrideRow>(
          `select employee_id, work_date::text, status,
                  manual_checkin_at, manual_checkout_at
           from public.attendance_day_overrides
           where tenant_id = $1::uuid and employee_id = any($2::uuid[])
             and work_date between $3::date and $4::date
             and deleted_at is null`,
          [tenantId, employeeIds, from, to],
        )
        .then((r) => r.rows),
      tx
        .query<CorrectionRow>(
          `select distinct on (c.employee_id, c.work_date)
                  c.employee_id, c.work_date::text, c.created_at, c.note,
                  c.old_value, c.new_value, u.name as actor_name
           from public.attendance_corrections c
           left join public.users u on u.id = c.actor_id
           where c.tenant_id = $1::uuid and c.employee_id = any($2::uuid[])
             and c.work_date between $3::date and $4::date
           order by c.employee_id, c.work_date, c.seq desc`,
          [tenantId, employeeIds, from, to],
        )
        .then((r) => r.rows),
    ]);

  const attemptsKey = new Set(
    attempts.map((r) => keyOf(r.employee_id, r.attempt_date)),
  );
  const recordKey = new Map(
    records.map((r) => [keyOf(r.employee_id, r.work_date), r]),
  );
  const overrideKey = new Map(
    overrides.map((r) => [keyOf(r.employee_id, r.work_date), r]),
  );
  const correctionKey = new Map(
    corrections.map((r) => [keyOf(r.employee_id, r.work_date), r]),
  );
  const leaveKey = new Map(
    leaveDays.map((r) => [keyOf(r.employee_id, r.leave_date), r]),
  );
  const rulesByOffice = new Map<string, OfficeRuleRow[]>();
  for (const rule of rules) {
    const list = rulesByOffice.get(rule.office_id) ?? [];
    list.push(rule);
    rulesByOffice.set(rule.office_id, list);
  }

  const dates = enumerateRange(from, to);
  const grid: DayGridRow[] = [];
  const rulelessRows: string[] = [];
  for (const employeeId of employeeIds) {
    for (const date of dates) {
      const assignment = assignments.find(
        (a) => a.employee_id === employeeId && rangeCoversRow(a.valid, date),
      );
      // The rule depends on the covering assignment's office (16-1 shape).
      const enrolment = enrolments.find(
        (e) => e.employee_id === employeeId && rangeCoversRow(e.valid, date),
      );
      const office: OfficeJoinRow | null = assignment
        ? {
            office_id: assignment.office_id,
            office_name: assignment.office_name,
            office_lat: assignment.office_lat,
            office_lng: assignment.office_lng,
            radius_m: assignment.radius_m,
          }
        : null;
      const facts: DayFacts = {
        enrolmentCovers: enrolment !== undefined,
        setupCompleted: settings?.setup_completed_at != null,
        enabled: settings?.enabled === true,
        enabledAt: enrolment ? new Date(enrolment.enabled_at) : null,
        enrolmentStart: enrolment ? parseDateRange(enrolment.valid).start : null,
        rule: assignment
          ? pickRuleForDate(rulesByOffice.get(assignment.office_id) ?? [], date)
          : null,
        weeklyOffDays: pickWeeklyOffDays(
          woOverrides.filter((o) => o.employee_id === employeeId),
          woDefaults,
          date,
        ),
        holidayId: holidayMap.get(date)?.id ?? null,
        holidayName: holidayMap.get(date)?.name ?? null,
      };
      const record = recordKey.get(keyOf(employeeId, date)) ?? null;
      const override = overrideKey.get(keyOf(employeeId, date)) ?? null;
      const leave = leaveKey.get(keyOf(employeeId, date)) ?? null;
      // FR-2's enable-day grace: a manual instant IS a recorded check-in.
      const timesOnly =
        override !== null &&
        (override.manual_checkin_at != null ||
          override.manual_checkout_at != null);
      const hasCheckIn = record !== null || timesOnly;
      const ctx = assembleDayContext(
        tenantId,
        employeeId,
        date,
        timezone,
        facts,
        office,
        hasCheckIn,
        leave ? { state: leave.state, part: leave.part } : null,
      );
      grid.push({
        employeeId,
        workDate: date,
        today,
        ctx,
        record: record
          ? {
              employee_id: record.employee_id,
              work_date: record.work_date,
              checkin_at: record.checkin_at,
              checkout_at: record.checkout_at,
            }
          : null,
        override: override
          ? {
              employee_id: override.employee_id,
              work_date: override.work_date,
              status: override.status,
              manual_checkin_at: override.manual_checkin_at,
              manual_checkout_at: override.manual_checkout_at,
            }
          : null,
        hasUnackMockedAttempt: attemptsKey.has(keyOf(employeeId, date)),
        latestCorrection: correctionKey.get(keyOf(employeeId, date)) ?? null,
      });
      // The D2 setup-gap watch: a tracked employee-date with an office but
      // no covering rule has no thresholds — grading is permissive there
      // (user ruling 2026-09-29). One warn per read, never per date.
      if (facts.rule === null) {
        rulelessRows.push(`${employeeId}|${date}`);
      }
    }
  }
  if (rulelessRows.length > 0) {
    logger.warn(
      'Attendance grid has dates with no covering office rule (setup gap; grading is permissive):',
      { sample: rulelessRows.slice(0, 10) },
    );
  }
  return grid;
}

function rangeCoversRow(valid: string, anchor: string): boolean {
  const { start, end } = parseDateRange(valid);
  return anchor >= start && (end === null || anchor < end);
}

/**
 * The day-statuses service (owner + `me` routes). The technician access
 * gate reads the AD-17 view row the way me/attendance does.
 */
@Injectable()
export class DayStatusesService {
  private readonly logger = new Logger(DayStatusesService.name);

  constructor(
    private readonly pg: PgPoolFactory,
    private readonly supabaseClientFactory: SupabaseClientFactory,
  ) {}

  /** Owner: GET /attendance/day-statuses?employeeId=&from=&to= */
  listForOwner(
    owner: RequestUser,
    employeeId: string,
    from: string,
    to: string,
  ): Promise<DayStatusesResponse> {
    const tenantId = requireTenant(owner);
    // The span cap runs BEFORE any per-date work (the validation DoS lesson).
    const range = validateDayStatusRange(from, to);
    if (!range.ok) {
      throw new HttpException(
        { error_code: ErrorCode.ATTENDANCE_INVALID_RANGE, message: range.message },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return this.pg.withTransaction(async (tx) => {
      const exists = await employeeExistsInTenant(tx, tenantId, employeeId);
      if (!exists) throw attendanceEmployeeNotFound();
      const rows = await readDayStatusGrid(tx, tenantId, [employeeId], from, to);
      return {
        employeeId,
        from,
        to,
        days: rows.map((row) => this.toResponseRow(row)),
      };
    });
  }

  /** Technician: GET /attendance/me/day-statuses?from=&to= */
  listMine(
    user: RequestUser,
    from: string,
    to: string,
  ): Promise<MeDayStatusesResponse> {
    const tenantId = requireTenant(user);
    const range = validateDayStatusRange(from, to);
    if (!range.ok) {
      throw new HttpException(
        { error_code: ErrorCode.ATTENDANCE_INVALID_RANGE, message: range.message },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return this.pg.withTransaction(async (tx) => {
      await requireAttendanceReadAccess(
        this.supabaseClientFactory.createAdmin(),
        user.userId,
      );
      const rows = await readDayStatusGrid(tx, tenantId, [user.userId], from, to);
      return { from, to, days: rows.map((row) => this.toResponseRow(row)) };
    });
  }

  /** One grid row → the wire row (the response mapper, imported math). */
  private toResponseRow(row: DayGridRow): DayStatusRow {
    const outcome: DayStatusOutcome = computeDayStatus({
      ctx: row.ctx,
      record: row.record,
      override: row.override,
      hasUnackMockedAttempt: row.hasUnackMockedAttempt,
      today: row.today,
    });
    const { checkin, checkout } = effectiveInstants(row.record, row.override);
    const latestCorrection: LatestCorrectionView | null = row.latestCorrection
      ? {
          // AD-7 tenant-offset spelling — the audit's UTC instant would show
          // the wrong wall time on the sheet (review G2-P9).
          correctedAt: toTenantOffsetIso(
            new Date(row.latestCorrection.created_at),
            row.ctx.timezone,
          ),
          actorName: row.latestCorrection.actor_name,
          note: row.latestCorrection.note,
          oldValue: validateCorrectionValue(row.latestCorrection.old_value),
          newValue: validateCorrectionValue(row.latestCorrection.new_value),
        }
      : null;
    return toDayStatusRow({
      workDate: row.workDate,
      isWeeklyOff: row.ctx.isWeeklyOff,
      holidayName: row.ctx.holidayName,
      isWorkingDay: row.ctx.isWorkingDay,
      officeId: row.ctx.officeId,
      officeName: row.ctx.officeName,
      timezone: row.ctx.timezone,
      outcome,
      checkin,
      checkout,
      latestCorrection,
    });
  }
}

/**
 * The AD-17 `me` access gate, shared by every technician read: none → 403
 * ATTENDANCE_NOT_TRACKED; history_only stays readable (D6).
 */
export async function requireAttendanceReadAccess(
  supabase: SupabaseClient,
  userId: string,
): Promise<void> {
  const { data, error } = await supabase
    .from('attendance_access_state')
    .select('user_id, access_state')
    .eq('user_id', userId)
    .maybeSingle<{
      user_id: string;
      access_state: AccessStateRow['access_state'];
    }>();
  if (error) {
    logger.error('Failed to read access state:', { error });
    throw internalError('Failed to read access state');
  }
  if (!data || data.access_state === 'none') {
    throw new ForbiddenException({
      error_code: ErrorCode.ATTENDANCE_NOT_TRACKED,
      message: 'Attendance is not active for you yet',
    });
  }
}

/** 404 with no existence leak (the 17-2 gate). */
export function attendanceEmployeeNotFound(): NotFoundException {
  return new NotFoundException({
    error_code: ErrorCode.ATTENDANCE_EMPLOYEE_NOT_FOUND,
    message: 'Employee not found in your company',
  });
}
