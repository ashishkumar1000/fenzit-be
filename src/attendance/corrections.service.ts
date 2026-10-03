import { Injectable, Logger } from '@nestjs/common';
import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCode } from '../common/enums/error-code.enum';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import type { PoolClient } from 'pg';
import { CursorScope, decodeCursor, encodeCursor } from '../common/utils/cursor.util';
import { PgPoolFactory } from '../common/pg/pg-pool.factory';
import { dbNow } from './check-in-out.repository';
import { toTenantOffsetIso } from './check-in-out.model';
import { dateInTz } from '../common/day-status/day-context';
import {
  attendanceEmployeeNotFound,
  requireAttendanceReadAccess,
} from './day-status.read';
import {
  readDayStatusGrid,
  type DayGridRow,
} from '../common/day-status/grid-reader';
import { computeDayStatus } from '../common/day-status/day-status.model';
import { internalError, requireTenant } from './attendance-rpc.helpers';
import { employeeExistsInTenant } from './leave.repository';
import { AttendanceCalendarDateConstraint } from './dto/attendance-date.validator';
import { isUUID } from 'class-validator';
import {
  EMPTY_CORRECTION_VALUE,
  toCorrectionEntry,
  type CorrectionEntry,
  type CorrectionValue,
} from './correction.model';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import {
  ackAttempts,
  findCorrectionHistory,
  insertCorrection,
  softDeleteOverride,
  upsertOverride,
} from './corrections.repository';

/**
 * Corrections write/read service (Epic 18, 18-2). Every write runs ONE
 * `withTransaction` under the `attendance_lock_employee` advisory lock
 * (AD-5; it also serialises the audit's seq ordering). `put`/`remove` run
 * the D4 gates and append ONE audit row; `acknowledge` needs none (D5 — an
 * ack is an idempotent UPDATE of rows that already exist). The list reads
 * carry the D6 owner 404 gate, and the `me` read runs the AD-17 access
 * gate. `attendance_records` is never touched (AD-12). No idempotency
 * header (AD-6's letter): a replayed PUT is a legitimate re-correction
 * (FR-21); the UNIQUE pair + seq are the last guards.
 */

const logger = new Logger('Corrections');

/** Note limits (also the DB CHECK's backstop). */
const NOTE_MAX = 500;
/** Control chars: C0 minus \t \n \r, DEL, zero-widths, BOM. */
const CONTROL_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B\u200C\u200D\uFEFF]/;

export interface PutCorrectionResponse {
  workDate: string;
  override: { status: string | null; checkinAt: string | null; checkoutAt: string | null };
  correctedAt: string;
  actorId: string;
}

export interface AcknowledgeResponse {
  acknowledgedCount: number;
}

export interface CorrectionPage {
  data: CorrectionEntry[];
  nextCursor: string | null;
  hasMore: boolean;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

/** One 422 helper — the house HttpException shape (leave.controller). */
function unprocessable(code: string, message: string): HttpException {
  return new HttpException(
    { error_code: code, message },
    HttpStatus.UNPROCESSABLE_ENTITY,
  );
}

/** The observable shape of an override row (audit + write response). */
function valueOfOverride(
  override: {
    status: string | null;
    manual_checkin_at: Date | string | null;
    manual_checkout_at: Date | string | null;
  },
  timezone: string,
): CorrectionValue {
  return {
    status: (override.status as CorrectionValue['status']) ?? null,
    checkinAt:
      override.manual_checkin_at != null
        ? toTenantOffsetIso(new Date(override.manual_checkin_at), timezone)
        : null,
    checkoutAt:
      override.manual_checkout_at != null
        ? toTenantOffsetIso(new Date(override.manual_checkout_at), timezone)
        : null,
  };
}

function dayAfter(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

@Injectable()
export class CorrectionsService {
  private readonly logger = new Logger(CorrectionsService.name);

  constructor(
    private readonly pg: PgPoolFactory,
    private readonly supabaseClientFactory: SupabaseClientFactory,
  ) {}

  /**
   * PUT /attendance/corrections/:employeeId/:workDate (owner). Gates in
   * D4's priority order, one upsert + one audit row, COMMIT.
   */
  put(
    owner: RequestUser,
    employeeId: string,
    workDate: string,
    value: { status?: string | null; checkinAt?: string | null; checkoutAt?: string | null },
    rawNote: string,
  ): Promise<PutCorrectionResponse> {
    const tenantId = requireTenant(owner);
    const actorId = owner.userId;
    this.assertEmployeeId(employeeId);
    this.assertWorkDate(workDate);
    return this.pg.withTransaction(async (tx) => {
      await this.lockEmployee(tx, employeeId);
      const row = await this.dayRow(tx, tenantId, employeeId, workDate);

      // Gate 1: employee scope (no existence leak) + note hygiene
      if (!(await employeeExistsInTenant(tx, tenantId, employeeId))) {
        throw attendanceEmployeeNotFound();
      }
      const note = rawNote.trim();
      if (CONTROL_CHARS.test(note)) {
        throw unprocessable(
          ErrorCode.VALIDATION_ERROR,
          'note contains invalid control characters',
        );
      }
      if (note.length < 1 || note.length > NOTE_MAX) {
        throw unprocessable(
          ErrorCode.VALIDATION_ERROR,
          'note must be between 1 and 500 characters after trimming',
        );
      }

      // Gate 2: the FR-21 date window (any past or current date)
      if (workDate > row.today) {
        throw unprocessable(
          ErrorCode.ATTENDANCE_FUTURE_DATE,
          'Corrections cannot target a future date',
        );
      }

      // Gate 3: tracked dates only (D4 rule 2; includes the FR-2 grace)
      if (computeDayStatus(row).status === 'not_tracked') {
        throw unprocessable(
          ErrorCode.ATTENDANCE_DATE_NOT_TRACKED,
          'Attendance is not tracked for this date',
        );
      }

      // Exactly one of status XOR times (mixing → 422 VALIDATION_ERROR)
      const hasStatus = value.status != null;
      const hasTimes = value.checkinAt != null || value.checkoutAt != null;
      if (hasStatus === hasTimes) {
        throw unprocessable(
          ErrorCode.VALIDATION_ERROR,
          'Provide exactly one of status or check-in/check-out times',
        );
      }
      if (!hasStatus && value.checkinAt == null) {
        // D4's times arm is { checkinAt, checkoutAt? }: a checkout alone
        // would write an instant the engine cannot see (rules 2-10 grade
        // from the check-in), so it must never reach the override.
        throw unprocessable(
          ErrorCode.VALIDATION_ERROR,
          'checkoutAt is not allowed without checkinAt',
        );
      }

      const tz = row.ctx.timezone;
      let newValue: CorrectionValue;
      if (hasStatus) {
        newValue = {
          status: value.status as CorrectionValue['status'],
          checkinAt: null,
          checkoutAt: null,
        };
      } else {
        // Gate 4: instants anchor the work_date (16-2's string compares)
        await this.validateInstants(tx, row, value.checkinAt ?? null, value.checkoutAt ?? null);
        newValue = {
          status: null,
          checkinAt: value.checkinAt
            ? toTenantOffsetIso(new Date(value.checkinAt), tz)
            : null,
          checkoutAt: value.checkoutAt
            ? toTenantOffsetIso(new Date(value.checkoutAt), tz)
            : null,
        };
      }

      const oldValue = this.captureOldValue(row, tz);
      await upsertOverride(tx, {
        tenantId,
        employeeId,
        workDate,
        status: hasStatus ? (value.status as string) : null,
        manualCheckinAt: value.checkinAt ?? null,
        manualCheckoutAt: value.checkoutAt ?? null,
        createdBy: actorId,
      });
      const audit = await insertCorrection(tx, {
        tenantId,
        employeeId,
        workDate,
        actorId,
        oldValue,
        newValue,
        note,
      });
      logger.log('correction applied', { tenantId, employeeId, workDate });
      return {
        workDate,
        override: { ...newValue },
        correctedAt: toTenantOffsetIso(new Date(audit.created_at), tz),
        actorId,
      };
    });
  }

  /** DELETE — soft delete; 200 { deleted:false } on an own retry. */
  remove(
    owner: RequestUser,
    employeeId: string,
    workDate: string,
  ): Promise<{ deleted: boolean }> {
    const tenantId = requireTenant(owner);
    const actorId = owner.userId;
    this.assertEmployeeId(employeeId);
    this.assertWorkDate(workDate);
    return this.pg.withTransaction(async (tx) => {
      if (!(await employeeExistsInTenant(tx, tenantId, employeeId))) {
        throw attendanceEmployeeNotFound();
      }
      await this.lockEmployee(tx, employeeId);
      const row = await this.dayRow(tx, tenantId, employeeId, workDate);

      // Non-tracked dates have nothing to remove → the same 422 as gate 3.
      if (computeDayStatus(row).status === 'not_tracked') {
        throw unprocessable(
          ErrorCode.ATTENDANCE_DATE_NOT_TRACKED,
          'Attendance is not tracked for this date',
        );
      }
      if (!row.override || workDate > row.today) {
        // An own removal retry (already soft-deleted, or nothing was ever
        // corrected) is 200-false — free.
        return { deleted: false };
      }

      const oldValue = valueOfOverride(row.override, row.ctx.timezone);
      const count = await softDeleteOverride(tx, tenantId, employeeId, workDate);
      if (count > 0) {
        await insertCorrection(tx, {
          tenantId,
          employeeId,
          workDate,
          actorId,
          oldValue,
          newValue: { ...EMPTY_CORRECTION_VALUE },
          note: 'Removed correction',
        });
        logger.log('correction removed', { tenantId, employeeId, workDate });
      } else {
        logger.warn('soft delete landed zero rows', {
          tenantId,
          employeeId,
          workDate,
        });
      }
      return { deleted: count > 0 };
    });
  }

  /**
   * POST /attendance/attempts/acknowledge (D5) — 200 even at 0 (a
   * read-shaped write; the UPDATE is naturally idempotent, rows are kept).
   */
  acknowledge(
    owner: RequestUser,
    employeeId: string,
    workDate: string,
  ): Promise<AcknowledgeResponse> {
    const tenantId = requireTenant(owner);
    this.assertWorkDate(workDate);
    return this.pg.withTransaction(async (tx) => {
      if (!(await employeeExistsInTenant(tx, tenantId, employeeId))) {
        throw attendanceEmployeeNotFound();
      }
      // The AD-5 lock — ack serialises against a concurrent put/remove on
      // the same employee like every other write path.
      await this.lockEmployee(tx, employeeId);
      const row = await tx.query<{ timezone: string }>(
        'select timezone from public.tenants where id = $1::uuid',
        [tenantId],
      );
      const timezone = row.rows[0]?.timezone;
      if (!timezone) {
        logger.error('Tenant timezone missing', { tenantId });
        throw internalError('Failed to resolve the tenant timezone');
      }
      const count = await ackAttempts(tx, {
        tenantId,
        employeeId,
        workDate,
        timezone,
      });
      return { acknowledgedCount: count };
    });
  }

  /** Owner history: one employee (required), optional workDate filter. */
  listOwner(
    owner: RequestUser,
    employeeId: string,
    input: { workDate?: string; cursor?: string; limit?: number },
  ): Promise<CorrectionPage> {
    return this.listTransact(owner, employeeId, input, 'day-corrections-owner');
  }

  /** Technician history: own entries only (identity from the JWT). */
  listMine(
    user: RequestUser,
    input: { workDate?: string; cursor?: string; limit?: number },
  ): Promise<CorrectionPage> {
    return this.listTransact(user, user.userId, input, 'day-corrections-me');
  }

  private async listTransact(
    user: RequestUser,
    employeeId: string,
    input: { workDate?: string; cursor?: string; limit?: number },
    scope: CursorScope,
  ): Promise<CorrectionPage> {
    const pageSize = Math.min(
      Math.max(input.limit ?? DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE,
    );
    const tenantId = requireTenant(user);
    if (scope === 'day-corrections-owner') {
      this.assertEmployeeId(employeeId);
    }
    return this.pg.withTransaction(async (tx) => {
      // The D6 scope gates: the owner read 404s a foreign employee (no
      // existence leak); the `me` read runs the AD-17 access gate.
      if (scope === 'day-corrections-owner') {
        if (!(await employeeExistsInTenant(tx, tenantId, employeeId))) {
          throw attendanceEmployeeNotFound();
        }
      } else {
        await requireAttendanceReadAccess(
          this.supabaseClientFactory.createAdmin(),
          user.userId,
        );
      }
      const tzRow = await tx.query<{ timezone: string }>(
        'select timezone from public.tenants where id = $1::uuid',
        [tenantId],
      );
      const timezone = tzRow.rows[0]?.timezone;
      if (!timezone) {
        logger.error('Tenant timezone missing', { tenantId });
        throw internalError('Failed to resolve the tenant timezone');
      }
      let cursorCreatedAt: string | undefined;
      let cursorId: string | undefined;
      if (input.cursor) {
        const decoded = decodeCursor(input.cursor, scope); // 400 on a foreign scope
        cursorCreatedAt = decoded.createdAt;
        cursorId = decoded.id;
      }
      const found = await findCorrectionHistory(tx, {
        tenantId,
        employeeId,
        workDate: input.workDate,
        cursorCreatedAt,
        cursorId,
        limit: pageSize,
      });
      const hasMore = found.length > pageSize;
      const page = hasMore ? found.slice(0, pageSize) : found;
      const last = page[page.length - 1];
      const nextCursor =
        hasMore && last
          ? encodeCursor(last.id, new Date(last.created_at).toISOString(), scope)
          : null;
      return {
        data: page.map((r) => toCorrectionEntry(r, r.actor_name, timezone)),
        nextCursor,
        hasMore,
      };
    });
  }

  private async lockEmployee(tx: PoolClient, employeeId: string): Promise<void> {
    await tx.query('select public.attendance_lock_employee($1)', [employeeId]);
  }

  /** Route param shape gate: workDate is a calendar date, not garbage. */
  private assertWorkDate(workDate: string): void {
    if (!new AttendanceCalendarDateConstraint().validate(workDate)) {
      throw unprocessable(
        ErrorCode.VALIDATION_ERROR,
        'workDate must be a valid calendar date in YYYY-MM-DD format',
      );
    }
  }

  /** Route param shape gate: a malformed employeeId is a 422, not the
   *  ParseUUIDPipe's raw 400 — the 422 house contract, decided at the
   *  service like every other correction gate (review G2-P8). */
  private assertEmployeeId(employeeId: string): void {
    if (!isUUID(employeeId)) {
      throw unprocessable(
        ErrorCode.VALIDATION_ERROR,
        'employeeId must be a UUID',
      );
    }
  }

  private async dayRow(
    tx: PoolClient,
    tenantId: string,
    employeeId: string,
    workDate: string,
  ): Promise<DayGridRow> {
    const rows = await readDayStatusGrid(tx, tenantId, [employeeId], workDate, workDate);
    const row = rows[0];
    if (!row) {
      logger.error('Day grid returned no row', { tenantId, employeeId, workDate });
      throw internalError('Failed to read the correction facts');
    }
    return row;
  }

  /** old_value seeding (D4): prior override shape → record grade → empty. */
  private captureOldValue(row: DayGridRow, timezone: string): CorrectionValue {
    if (row.override) {
      return valueOfOverride(row.override, timezone);
    }
    if (row.record) {
      const recordWithoutOverride: DayGridRow = { ...row, override: null };
      const outcome = computeDayStatus(recordWithoutOverride);
      return {
        status: outcome.status,
        checkinAt: toTenantOffsetIso(new Date(row.record.checkin_at), timezone),
        checkoutAt: row.record.checkout_at
          ? toTenantOffsetIso(new Date(row.record.checkout_at), timezone)
          : null,
      };
    }
    return { ...EMPTY_CORRECTION_VALUE };
  }

  /** Gate 4: instants anchor the work_date — 16-2's compare shape, plus
   *  checkinAt AND checkoutAt not in the future relative to DB now. */
  private async validateInstants(
    tx: PoolClient,
    row: DayGridRow,
    checkinAt: string | null,
    checkoutAt: string | null,
  ): Promise<void> {
    const tz = row.ctx.timezone;
    if (checkinAt !== null) {
      const anchor = dateInTz(new Date(checkinAt), tz);
      if (anchor !== row.workDate) {
        throw unprocessable(
          ErrorCode.ATTENDANCE_INVALID_RANGE,
          'checkinAt must fall on the work date',
        );
      }
      const now = await dbNow(tx);
      if (new Date(checkinAt).getTime() > now.getTime()) {
        throw unprocessable(
          ErrorCode.ATTENDANCE_INVALID_RANGE,
          'checkinAt cannot be in the future',
        );
      }
    }
    if (checkoutAt !== null) {
      const anchor = dateInTz(new Date(checkoutAt), tz);
      if (anchor !== row.workDate && anchor !== dayAfter(row.workDate)) {
        throw unprocessable(
          ErrorCode.ATTENDANCE_INVALID_RANGE,
          'checkoutAt must fall on the work date (or the next day)',
        );
      }
      const now = await dbNow(tx);
      if (new Date(checkoutAt).getTime() > now.getTime()) {
        throw unprocessable(
          ErrorCode.ATTENDANCE_INVALID_RANGE,
          'checkoutAt cannot be in the future',
        );
      }
    }
    if (
      checkinAt !== null &&
      checkoutAt !== null &&
      new Date(checkoutAt).getTime() <= new Date(checkinAt).getTime()
    ) {
      throw unprocessable(
        ErrorCode.ATTENDANCE_INVALID_RANGE,
        'checkoutAt must be after checkinAt',
      );
    }
  }
}

export { attendanceEmployeeNotFound };
