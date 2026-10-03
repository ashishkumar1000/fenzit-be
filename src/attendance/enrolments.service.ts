import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { PgPoolFactory } from '../common/pg/pg-pool.factory';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { ErrorCode } from '../common/enums/error-code.enum';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { internalError, requireTenant } from './attendance-rpc.helpers';
import {
  EnrolmentQueryDto,
  ReassignOfficeDto,
  SetEnrolmentDto,
} from './dto/enrolment.dto';
import {
  AccessStateResponse,
  AccessStateRow,
  EnrolmentOverviewResponse,
  addDays,
  parseDateRange,
  planAd8Change,
  toAccessStateResponse,
} from './enrolments-response.model';
import {
  PgError,
  attendanceRecordsExist,
  clipRangeEnd,
  deleteRanges,
  hasCheckInOn,
  insertAssignment,
  insertEnrolment,
  lockTenantShared,
  readAccessState,
  readAssignments,
  readEmployee,
  readEnrolments,
  readOffice,
  tenantToday,
} from './enrolments.repository';
import { cancelLeaveOnDisable } from './leave-transition';

/** The open-transaction client handed to repository functions. */
type Tx = PoolClient;

const NONE_STATE: AccessStateResponse = {
  attendanceEnabled: false,
  attendanceAccess: 'none',
  attendanceStartDate: null,
  attendanceEndedOn: null,
  enabledAt: null,
  onboardedAt: null,
  officeId: null,
  officeName: null,
};

/**
 * FR-2/FR-6 enrolment lifecycle (15-7). No new RPCs (user decision
 * 2026-09-28): each write is ONE pg transaction — the shared tenant lock
 * via the existing AD-5 helper (same lock space as the RPCs), the existing
 * attendance_today, the AD-8 plan computed by the pure model, then COMMIT
 * past the deferrable coverage trigger. Reads go through the
 * attendance_access_state view, so access state is computed once, in SQL.
 */
@Injectable()
export class EnrolmentsService {
  private readonly logger = new Logger(EnrolmentsService.name);

  constructor(
    private readonly supabaseClientFactory: SupabaseClientFactory,
    private readonly pgPoolFactory: PgPoolFactory,
  ) {}

  /**
   * GET /attendance/enrolments — the owner roster: every technician's
   * access state from the view, joined with display names (owners are
   * never enrolled, so the view is read for the tenant's technicians only).
   */
  async listEnrolments(
    user: RequestUser,
  ): Promise<EnrolmentOverviewResponse[]> {
    const tenantId = requireTenant(user);
    const admin = this.supabaseClientFactory.createAdmin();

    const { data, error } = await admin
      .from('users')
      .select('id, name, country_code, phone_number')
      .eq('tenant_id', tenantId)
      .eq('role', 'technician');
    if (error) {
      this.logger.error('Failed to list tenant technicians:', { error });
      throw internalError('Failed to read enrolments');
    }
    const technicians = (data ?? []) as Array<{
      id: string;
      name: string | null;
      country_code: string | null;
      phone_number: string | null;
    }>;
    if (technicians.length === 0) {
      return [];
    }

    const { data: stateRows, error: stateError } = await admin
      .from('attendance_access_state')
      .select('*')
      .eq('tenant_id', tenantId)
      .in(
        'user_id',
        technicians.map((t) => t.id),
      );
    if (stateError) {
      this.logger.error('Failed to read access states:', { error: stateError });
      throw internalError('Failed to read enrolments');
    }

    const stateById = new Map<string, AccessStateRow>(
      ((stateRows ?? []) as AccessStateRow[]).map((row) => [row.user_id, row]),
    );
    return technicians.map((t) => {
      const state = stateById.get(t.id);
      const phone = `${t.country_code ?? ''}${t.phone_number ?? ''}`;
      return {
        ...(state ? toAccessStateResponse(state) : NONE_STATE),
        employeeId: t.id,
        employeeName: t.name || phone || 'Unknown employee',
        phone,
      };
    });
  }

  /**
   * PUT /attendance/enrolments/:employeeId — FR-2 enable / set-or-change a
   * future start date. Co-writes the enrolment AND the office assignment
   * atomically (the coverage trigger makes a stranded date impossible).
   */
  async setEnrolment(
    user: RequestUser,
    employeeId: string,
    dto: SetEnrolmentDto,
  ): Promise<AccessStateResponse> {
    const tenantId = requireTenant(user);
    return this.inTransaction(async (tx) => {
      const today = await this.openLifecycle(tx, tenantId, employeeId);
      // AD-8 step 1: a past date is clamped to today, never a 422.
      const start =
        dto.startDate && dto.startDate > today ? dto.startDate : today;

      await this.requireTenantEmployee(tx, tenantId, employeeId);
      const office = await readOffice(tx, tenantId, dto.officeId);
      if (office.archived_at) {
        throw this.archivedOffice(office.name);
      }

      // Assignments first: the guard validates the full invariant at
      // COMMIT, so both halves land together — this order just keeps any
      // statement-level failure from ever leaving an assignment behind.
      await this.applyPlan(
        tx,
        employeeId,
        dto.officeId,
        tenantId,
        start,
        true,
        true,
      );
      await this.applyPlan(
        tx,
        employeeId,
        dto.officeId,
        tenantId,
        start,
        true,
        false,
      );

      return toAccessStateResponse(
        await readAccessState(tx, tenantId, employeeId),
      );
    });
  }

  /**
   * PUT /attendance/enrolments/:employeeId/office — FR-6 reassignment.
   * Tomorrow (not the chosen date) when the employee already checked in
   * today — the probe is guarded until Epic 16's table exists.
   */
  async reassignOffice(
    user: RequestUser,
    employeeId: string,
    dto: ReassignOfficeDto,
  ): Promise<AccessStateResponse> {
    const tenantId = requireTenant(user);
    return this.inTransaction(async (tx) => {
      const today = await this.openLifecycle(tx, tenantId, employeeId);
      let effectiveFrom =
        dto.effectiveFrom && dto.effectiveFrom > today
          ? dto.effectiveFrom
          : today;

      await this.requireTenantEmployee(tx, tenantId, employeeId);
      const office = await readOffice(tx, tenantId, dto.officeId);
      if (office.archived_at) {
        throw this.archivedOffice(office.name);
      }

      // FR-6: a change after today's check-in applies from tomorrow.
      if (
        effectiveFrom === today &&
        (await attendanceRecordsExist(tx)) &&
        (await hasCheckInOn(tx, employeeId, today))
      ) {
        effectiveFrom = addDays(today, 1);
      }

      const enrolments = await readEnrolments(tx, employeeId);
      const covering = enrolments.find((row) =>
        rangeContains(parseDateRange(row.valid), effectiveFrom),
      );
      if (!covering) {
        throw new HttpException(
          {
            error_code: ErrorCode.ATTENDANCE_ASSIGNMENT_NOT_ENROLLED,
            message: 'No attendance record covers that date yet.',
          },
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }

      await this.applyPlan(
        tx,
        employeeId,
        dto.officeId,
        tenantId,
        effectiveFrom,
        true,
        true,
      );

      return toAccessStateResponse(
        await readAccessState(tx, tenantId, employeeId),
      );
    });
  }

  /**
   * DELETE /attendance/enrolments/:employeeId — FR-2 disable: the AD-8
   * plan without the insert, run against BOTH tables. History stays
   * read-only; cancelling a future start removes the rows entirely.
   */
  async disableEnrolment(
    user: RequestUser,
    employeeId: string,
    query: EnrolmentQueryDto,
  ): Promise<AccessStateResponse> {
    const tenantId = requireTenant(user);
    return this.inTransaction(async (tx) => {
      const today = await this.openLifecycle(tx, tenantId, employeeId);
      const effectiveFrom =
        query.effectiveFrom && query.effectiveFrom > today
          ? query.effectiveFrom
          : today;

      await this.requireTenantEmployee(tx, tenantId, employeeId);

      await this.applyPlan(
        tx,
        employeeId,
        null,
        tenantId,
        effectiveFrom,
        false,
        true,
      );
      await this.applyPlan(
        tx,
        employeeId,
        null,
        tenantId,
        effectiveFrom,
        false,
        false,
      );

      // AD-23's disable cause, live since the leave tables exist (spec-17
      // D12): ALL pending leave + approved leave from the effective date is
      // cancelled, and the employee is notified. Same transaction; the
      // AD-5 locks are already held in the right order.
      await cancelLeaveOnDisable(tx, tenantId, employeeId, effectiveFrom);

      return toAccessStateResponse(
        await readAccessState(tx, tenantId, employeeId),
      );
    });
  }

  /**
   * Executes one AD-8 plan: `table` selects the owner key (assignments
   * first, then enrolments — `assignmentsFirst` encodes the caller's
   * ordering), `insert` toggles disable's clip-without-insert, and
   * `officeId` rides the new assignment row.
   */
  private async applyPlan(
    tx: Tx,
    employeeId: string,
    officeId: string | null,
    tenantId: string,
    effectiveFrom: string,
    insert: boolean,
    isAssignment: boolean,
  ): Promise<void> {
    const table = isAssignment
      ? 'attendance_office_assignments'
      : 'attendance_enrolments';
    const rows = isAssignment
      ? await readAssignments(tx, employeeId)
      : await readEnrolments(tx, employeeId);
    const plan = planAd8Change(rows, effectiveFrom, insert);

    await deleteRanges(tx, table, plan.deleteIds);
    if (plan.clipId && plan.clipEnd) {
      await clipRangeEnd(tx, table, plan.clipId, plan.clipEnd);
    }
    if (plan.insertStart && insert) {
      if (isAssignment && officeId) {
        await insertAssignment(
          tx,
          tenantId,
          employeeId,
          officeId,
          plan.insertStart,
        );
      } else if (!isAssignment) {
        await insertEnrolment(tx, tenantId, employeeId, plan.insertStart);
      }
    }
  }

  /**
   * Opens every lifecycle transaction the same way (AD-5): the SHARED tenant
   * lock via the existing helper — the same lock space as the attendance
   * RPCs — then the EXCLUSIVE employee lock (per-employee write; two owners
   * racing on one employee must serialise), then `attendance_today`.
   */
  private async openLifecycle(
    tx: Tx,
    tenantId: string,
    employeeId: string,
  ): Promise<string> {
    await lockTenantShared(tx, tenantId);
    await tx.query('select public.attendance_lock_employee($1)', [employeeId]);
    try {
      return await tenantToday(tx, tenantId);
    } catch (err) {
      if ((err as PgError)?.hint === 'ATTENDANCE_TENANT_NOT_FOUND') {
        throw new NotFoundException({
          error_code: ErrorCode.ATTENDANCE_TENANT_NOT_FOUND,
          message: 'Company setup required before using attendance',
        });
      }
      this.logger.error('attendance_today failed:', { err });
      throw internalError('Failed to resolve tenant date');
    }
  }

  /**
   * One pg transaction with the documented error mapping: the coverage
   * trigger's COMMIT-time rejection (23514 + ATTENDANCE_ASSIGNMENT_GAP hint)
   * surfaces as 422, never a raw 500 (review finding — the docs promised a
   * 422 nothing produced).
   */
  private async inTransaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await this.pgPoolFactory.withTransaction(work);
    } catch (err) {
      const pgErr = err as PgError;
      if (pgErr?.hint === 'ATTENDANCE_ASSIGNMENT_GAP') {
        throw new HttpException(
          {
            error_code: ErrorCode.ATTENDANCE_ASSIGNMENT_GAP,
            message: 'Assign this person to an office first.',
          },
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      throw err;
    }
  }

  /** 404 unless the employee belongs to the caller's tenant. */
  private async requireTenantEmployee(
    tx: Tx,
    tenantId: string,
    employeeId: string,
  ): Promise<void> {
    const employee = await readEmployee(tx, tenantId, employeeId);
    if (!employee) {
      throw new NotFoundException({
        error_code: ErrorCode.ATTENDANCE_EMPLOYEE_NOT_FOUND,
        message: 'Employee not found',
      });
    }
  }

  private archivedOffice(name: string): HttpException {
    return new HttpException(
      {
        error_code: ErrorCode.ATTENDANCE_OFFICE_ARCHIVED,
        message: `${name} is archived. Pick an active office.`,
      },
      HttpStatus.CONFLICT,
    );
  }
}

/** `[start, end)` containment for a single date. */
function rangeContains(
  range: { start: string; end: string | null },
  date: string,
): boolean {
  return range.start <= date && (range.end === null || range.end > date);
}
