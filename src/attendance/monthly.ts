import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { PgPoolFactory } from '../common/pg/pg-pool.factory';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { ErrorCode } from '../common/enums/error-code.enum';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { requireTenant } from './attendance-rpc.helpers';
import { tenantToday } from './enrolments.repository';
import {
  readDayStatusGrid,
  requireAttendanceReadAccess,
  type DayGridRow,
} from './day-status.read';
import { pickWeeklyOffDays, type WeeklyOffRow } from './me-summary.model';
import { summariseEmployeeMonth } from './monthly-summary.model';
import type {
  EmployeeMonthlyRow,
  HolidayRow,
  MeMonthlyResponse,
  MonthlyResponse,
} from './monthly-response.model';

/**
 * 19-3's monthly & self-view reads (spec D6): owner `GET /attendance/
 * monthly` and technician `GET /attendance/me/monthly` — TWO routes over
 * ONE aggregation (monthly-summary.model.ts, pure over the day-status
 * engine's `readDayStatusGrid` rows; FR-11's totals parity is structural
 * because the two routes share that one function).
 *
 * Range rules (422 ATTENDANCE_INVALID_RANGE, validated BEFORE the
 * transaction): `from` ≤ `to`, span ≤ 31 days (a month — the NFR-7
 * budget's shape), and `to` ≤ tenant-today (the aggregate is a record of
 * earned credits; future dates carry none yet and would mislabel the
 * summary).
 *
 * The route adds NO rule of its own: statuses, credits and flags come
 * from `computeDayStatus` exactly as the calendar and the day sheet show
 * them. Owner rows include history-only and disabled employees with any
 * tracked day in the range (FR-28) — dates after disable read
 * `not_tracked` naturally and drop out of every count.
 */

/** A month, not 62 — D6's cap (the NFR-7 budget's shape, spec §3). */
const MONTHLY_MAX_SPAN_DAYS = 31;

/** One row of the owner route's employee-set read (roster office = today). */
interface EmployeeMetaRow {
  employee_id: string;
  employee_name: string;
  office_id: string | null;
  office_name: string | null;
}

/**
 * The monthly range validator (from ≤ to, span ≤ 31) — the date FORMAT is
 * the DTO's `AttendanceCalendarDateConstraint`; `to ≤ tenant-today` is the
 * service's clock check against `tenantToday`. Any failure → one 422 shape.
 */
function assertMonthlyRange(from: string, to: string): void {
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRe.test(from) || !dateRe.test(to)) {
    throw monthlyRangeError('Dates must be in YYYY-MM-DD format');
  }
  if (to < from) {
    throw monthlyRangeError('The end date cannot be before the start date');
  }
  const spanDays = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
  if (spanDays > MONTHLY_MAX_SPAN_DAYS) {
    throw monthlyRangeError(
      `A monthly range covers at most ${MONTHLY_MAX_SPAN_DAYS} days`,
    );
  }
}

function monthlyRangeError(message: string): HttpException {
  return new HttpException(
    { error_code: ErrorCode.ATTENDANCE_INVALID_RANGE, message },
    HttpStatus.UNPROCESSABLE_ENTITY,
  );
}

/**
 * The owner's monthly read: every enrolment covering ANY date of the range
 * (a mid-month joiner still gets their covered dates; FR-28's
 * history-only/disabled employees included while any day stays tracked),
 * the grid over `employeeIds × [from, to]`, then summary per employee.
 *
 * office = the assignment covering TODAY (the roster's current office —
 * D6; a past-month office move is out of monthly scope). With an
 * officeId filter, only employees whose today-covering assignment's
 * office matches survive the set (unknown-but-well-formed officeId →
 * zero rows, 200, never 404).
 */
@Injectable()
export class MonthlyService {
  constructor(
    private readonly pg: PgPoolFactory,
    private readonly supabaseClientFactory: SupabaseClientFactory,
  ) {}

  forOwner(
    owner: RequestUser,
    from: string,
    to: string,
    officeId?: string,
  ): Promise<MonthlyResponse> {
    const tenantId = requireTenant(owner);
    assertMonthlyRange(from, to);
    return this.pg.withTransaction(async (tx) => {
      const today = await tenantToday(tx, tenantId);
      if (to > today) {
        throw monthlyRangeError(
          'The end date cannot be after today',
        );
      }
      const metas = await this.readEmployeeMetas(
        tx,
        tenantId,
        from,
        to,
        today,
        officeId ?? null,
      );
      const employeeIds = metas.map((m) => m.employee_id);
      if (employeeIds.length === 0) {
        return { from, to, today, employees: [] };
      }
      const rows = await readDayStatusGrid(
        tx,
        tenantId,
        employeeIds,
        from,
        to,
      );
      const byEmployee = new Map<string, DayGridRow[]>();
      for (const row of rows) {
        const list = byEmployee.get(row.employeeId) ?? [];
        list.push(row);
        byEmployee.set(row.employeeId, list);
      }
      const employees: EmployeeMonthlyRow[] = metas.map((meta) => ({
        employeeId: meta.employee_id,
        employeeName: meta.employee_name,
        officeId: meta.office_id,
        officeName: meta.office_name,
        summary: summariseEmployeeMonth(
          byEmployee.get(meta.employee_id) ?? [],
        ),
      }));
      // Roster order: alphabetically by resolved name (deterministic; the
      // FE sorts locally if it wants another shape).
      employees.sort((a, b) =>
        a.employeeName === b.employeeName
          ? a.employeeId < b.employeeId
            ? -1
            : 1
          : a.employeeName < b.employeeName
            ? -1
            : 1,
      );
      return { from, to, today, employees };
    });
  }

  /**
   * The self view: identity from the JWT only, the AD-17 access gate
   * (`none` → 403; `history_only` reads the own-records rows — the 18-x
   * me-route precedent), the same summary shape, plus the today-effective
   * weekly-off weekdays and the tenant's next 10 upcoming holidays.
   */
  forMe(user: RequestUser, from: string, to: string): Promise<MeMonthlyResponse> {
    const tenantId = requireTenant(user);
    assertMonthlyRange(from, to);
    return this.pg.withTransaction(async (tx) => {
      await requireAttendanceReadAccess(
        this.supabaseClientFactory.createAdmin(),
        user.userId,
      );
      const today = await tenantToday(tx, tenantId);
      if (to > today) {
        throw monthlyRangeError('The end date cannot be after today');
      }
      const rows = await readDayStatusGrid(tx, tenantId, [user.userId], from, to);
      const summary = summariseEmployeeMonth(rows);
      const weeklyOffs = await this.readWeeklyOffDays(tx, tenantId, user.userId, today);
      const upcomingHolidays = await this.readUpcomingHolidays(
        tx,
        tenantId,
        today,
      );
      return { from, to, today, summary, weeklyOffs, upcomingHolidays };
    });
  }

  /**
   * The employee set (D6): enrolments covering any range date, joined to
   * the assignment covering TODAY for the roster office + the filter.
   * `distinct on` keeps one row per employee when a re-enrolment makes
   * several enrolment rows overlap the range (oldest wins — deterministic).
   */
  private async readEmployeeMetas(
    tx: PoolClient,
    tenantId: string,
    from: string,
    to: string,
    today: string,
    officeId: string | null,
  ): Promise<EmployeeMetaRow[]> {
    const { rows } = await tx.query<EmployeeMetaRow>(
      `select distinct on (e.employee_id)
              e.employee_id,
              coalesce(nullif(u.name, ''), u.country_code || u.phone_number,
                       'Unknown employee') as employee_name,
              a.office_id, o.name as office_name
       from public.attendance_enrolments e
       join public.users u on u.id = e.employee_id
       left join lateral (
         select a2.office_id
         from public.attendance_office_assignments a2
         where a2.employee_id = e.employee_id
           and a2.tenant_id = e.tenant_id
           and a2.valid @> $2::date
         limit 1
       ) a on true
       left join public.attendance_offices o on o.id = a.office_id
       where e.tenant_id = $1::uuid
         and e.valid && $3::daterange
         and ($4::uuid is null or a.office_id = $4::uuid)
       order by e.employee_id, e.valid::text asc`,
      [tenantId, today, `[${from},${to}]`, officeId],
    );
    return rows;
  }

  /**
   * The today-effective weekly-off weekdays — defaults plus an override
   * REPLACEing them, via the imported `pickWeeklyOffDays` contract
   * (me/summary's picker, never re-derived here).
   */
  private async readWeeklyOffDays(
    tx: PoolClient,
    tenantId: string,
    employeeId: string,
    today: string,
  ): Promise<number[]> {
    const [overrides, defaults] = await Promise.all([
      tx
        .query<WeeklyOffRow>(
          `select valid::text, days from public.attendance_weekly_off_overrides
           where tenant_id = $1::uuid and employee_id = $2::uuid
             and valid @> $3::date`,
          [tenantId, employeeId, today],
        )
        .then((r) => r.rows),
      tx
        .query<WeeklyOffRow>(
          `select valid::text, days from public.attendance_weekly_off_defaults
           where tenant_id = $1::uuid and valid @> $2::date`,
          [tenantId, today],
        )
        .then((r) => r.rows),
    ]);
    return pickWeeklyOffDays(overrides, defaults, today);
  }

  /** Tenant holidays from today, next 10 (the self card's list). */
  private async readUpcomingHolidays(
    tx: PoolClient,
    tenantId: string,
    today: string,
  ): Promise<HolidayRow[]> {
    const { rows } = await tx.query<{
      holiday_date: string;
      holiday_name: string;
    }>(
      `select holiday_date::text, name as holiday_name
       from public.holidays
       where tenant_id = $1::uuid and holiday_date >= $2::date
       order by holiday_date asc
       limit 10`,
      [tenantId, today],
    );
    return rows.map((r) => ({
      holidayDate: r.holiday_date,
      holidayName: r.holiday_name,
    }));
  }
}
