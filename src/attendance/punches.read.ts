import { Injectable } from '@nestjs/common';
import { HttpException, HttpStatus } from '@nestjs/common';
import { PgPoolFactory } from '../common/pg/pg-pool.factory';
import { ErrorCode } from '../common/enums/error-code.enum';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { requireTenant } from './attendance-rpc.helpers';
import { toTenantOffsetIso } from './check-in-out.model';
import { employeeExistsInTenant } from './leave.repository';
import { tenantToday } from './enrolments.repository';
import { attendanceEmployeeNotFound } from './day-status.read';
import { validateDayStatusRange } from './day-status.read';
import { readDayStatusGrid } from '../common/day-status/grid-reader';
import {
  computeDayStatus,
  effectiveInstants,
  type DayStatusOutcome,
} from '../common/day-status/day-status.model';

/**
 * The admin punch-history read (employee profile story, 2026-11-21): one
 * employee's check-in/out rows over a range. It reads the SAME day-status
 * grid the Epic-18 surfaces use (`common/day-status/grid-reader`), so a
 * corrected time, a weekly-off or a leave marker can never disagree between
 * the profile and the attendance pages — this endpoint only reshapes the
 * grid rows that actually carry a punch into history rows, newest first.
 * Owner route, D6 404-no-leak, span cap BEFORE any per-date work.
 */

export interface PunchRow {
  workDate: string;
  /** The effective instants (a manual correction replaces the raw ones). */
  checkinAt: string | null;
  checkinDistanceM: number | null;
  checkoutAt: string | null;
  checkoutDistanceM: number | null;
  officeId: string | null;
  officeName: string | null;
  /** The 12-key day-status vocabulary, for the row's status pill. */
  status: DayStatusOutcome['status'];
  /** True when the instants came from an admin correction, not the GPS pair. */
  corrected: boolean;
}

export interface PunchesResponse {
  employeeId: string;
  from: string;
  to: string;
  today: string;
  punches: PunchRow[];
}

@Injectable()
export class PunchesService {
  constructor(private readonly pg: PgPoolFactory) {}

  /** Owner: GET /attendance/punches?employeeId=&from=&to= */
  async listForOwner(
    owner: RequestUser,
    employeeId: string,
    from: string,
    to: string,
  ): Promise<PunchesResponse> {
    const tenantId = requireTenant(owner);
    const range = validateDayStatusRange(from, to);
    if (!range.ok) {
      throw new HttpException(
        {
          error_code: ErrorCode.ATTENDANCE_INVALID_RANGE,
          message: range.message,
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return this.pg.withTransaction(async (tx) => {
      const exists = await employeeExistsInTenant(tx, tenantId, employeeId);
      if (!exists) throw attendanceEmployeeNotFound();
      const rows = await readDayStatusGrid(tx, tenantId, [employeeId], from, to);
      const today = rows[0]?.today ?? (await tenantToday(tx, tenantId));
      const punches = rows
        .map((row) => {
          const outcome = computeDayStatus({
            ctx: row.ctx,
            record: row.record,
            override: row.override,
            hasUnackMockedAttempt: row.hasUnackMockedAttempt,
            today: row.today,
          });
          const { checkin, checkout } = effectiveInstants(row.record, row.override);
          // spec-18-3 D2: a distance is shown only when the paired source is
          // the original GPS fix — a times-only correction never gains one.
          const checkinDistanceM =
            outcome.checkinSource === 'gps' && row.record
              ? row.record.checkin_distance_m
              : null;
          const checkoutDistanceM =
            outcome.checkoutSource === 'gps' && row.record
              ? row.record.checkout_distance_m
              : null;
          const corrected =
            outcome.checkinSource === 'manual' || outcome.checkoutSource === 'manual';
          return {
            workDate: row.workDate,
            // AD-7 tenant-offset spelling — the raw UTC instant would show the
            // wrong wall time (the day-statuses rows spell it the same way).
            checkinAt:
              checkin != null
                ? toTenantOffsetIso(checkin, row.ctx.timezone)
                : null,
            checkinDistanceM,
            checkoutAt:
              checkout != null
                ? toTenantOffsetIso(checkout, row.ctx.timezone)
                : null,
            checkoutDistanceM,
            officeId: row.ctx.officeId,
            officeName: row.ctx.officeName,
            status: outcome.status,
            corrected,
          };
        })
        .filter((punch) => punch.checkinAt !== null || punch.checkoutAt !== null)
        .reverse();
      return { employeeId, from, to, today, punches };
    });
  }
}
