import { ForbiddenException, HttpException, HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { PgPoolFactory } from '../common/pg/pg-pool.factory';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { ErrorCode } from '../common/enums/error-code.enum';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { internalError, requireTenant } from './attendance-rpc.helpers';
import { employeeExistsInTenant } from './leave.repository';
import { tenantToday } from './enrolments.repository';
import type { AccessStateRow } from './enrolments-response.model';
import {
  computeDayStatus,
  effectiveInstants,
  type DayStatusOutcome,
} from '../common/day-status/day-status.model';
import {
  readDayStatusGrid,
  type DayGridRow,
  type RecordRow,
  type OverrideRow,
} from '../common/day-status/grid-reader';
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
 * FR-10 engine outcomes over a range, inside ONE transaction. The grid
 * assembly itself lives in `common/day-status/grid-reader.ts` (extracted
 * 21-1) so the Epic 19 aggregates, the corrections service and the reports
 * fetcher assemble facts through the SAME reader (the 15-9 drift class
 * stays closed at the reader level). This file keeps the HTTP seam: the
 * route validators, the service class and the AD-17 access gate.
 *
 * Owner routes verify the employee 404-no-leak (D6). `me` routes run the
 * AD-17 access gate (none → 403; history_only readable).
 */

const logger = new Logger('DayStatusRead');

/** Re-exported for the specs and callers that build real-typed grid rows. */
export type { DayGridRow, RecordRow, OverrideRow };

export const DAY_STATUSES_MAX_SPAN_DAYS = 62;

/**
 * The D6/D7 range validator (owner + me): the span cap runs BEFORE any
 * per-date work (the leave-validation DoS lesson).
 */
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
        today: rows[0]?.today ?? (await tenantToday(tx, tenantId)),
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
      return {
        from,
        to,
        today: rows[0]?.today ?? (await tenantToday(tx, tenantId)),
        days: rows.map((row) => this.toResponseRow(row)),
      };
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
    // spec-18-3 D2: the stored distances describe the ORIGINAL GPS fix — a
    // times-only correction substitutes manual instants, so a distance is
    // surfaced ONLY when the paired source is 'gps' (never paired with a
    // manual time).
    const checkinDistanceM =
      outcome.checkinSource === 'gps' && row.record
        ? row.record.checkin_distance_m
        : null;
    const checkoutDistanceM =
      outcome.checkoutSource === 'gps' && row.record
        ? row.record.checkout_distance_m
        : null;
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
      checkinDistanceM,
      checkoutDistanceM,
      leaveRequestId: row.ctx.leaveRequestId,
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
