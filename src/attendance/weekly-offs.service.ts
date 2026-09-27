import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { ErrorCode } from '../common/enums/error-code.enum';
import { RequestUser } from '../common/interfaces/request-user.interface';
import {
  RemoveOverrideQueryDto,
  SetWeeklyOffDefaultDto,
  SetWeeklyOffOverrideDto,
} from './dto/weekly-off.dto';
import {
  pickCurrentWeeklyOff,
  pickNextWeeklyOff,
  toWeeklyOffHistory,
  toWeeklyOffView,
  WeeklyOffDefaultResponse,
  WeeklyOffOverrideResponse,
  WeeklyOffRow,
} from './weekly-offs-response.model';
import {
  Admin,
  HINT_EMPLOYEE_NOT_FOUND,
  HINT_NO_WORKING_DAYS,
  HINT_TENANT_NOT_FOUND,
  PG_CHECK_VIOLATION,
  internalError,
  requireTenant,
  resolveTenantToday,
  tenantNotFoundError,
  type RpcError,
} from './attendance-rpc.helpers';
import {
  readDefaults,
  readEmployeeNames,
  readOverrides,
} from './weekly-offs.repository';

/**
 * FR-18/FR-19 weekly offs: the tenant default and per-employee overrides,
 * both effective-dated (AD-8) through the lifecycle RPCs (20260927000005 —
 * no actor parameter; the tables carry no audit columns). Writes are lock
 * -serialised inside the RPCs; reads are fetch-and-pick: the range picks
 * happen on the few fetched rows against attendance_today.
 */
@Injectable()
export class WeeklyOffsService {
  private readonly logger = new Logger(WeeklyOffsService.name);

  constructor(private readonly supabaseClientFactory: SupabaseClientFactory) {}

  /**
   * GET /attendance/weekly-offs — the selection valid today (null = all 7
   * days working), the earliest pending edit, and the full history.
   */
  async getWeeklyOffs(user: RequestUser): Promise<WeeklyOffDefaultResponse> {
    const tenantId = requireTenant(user);
    const admin = this.supabaseClientFactory.createAdmin();
    const today = await resolveTenantToday(admin, tenantId);
    const rows = await readDefaults(admin, tenantId);
    return {
      default: toViewOrNull(pickCurrentWeeklyOff(rows, today)),
      next: toViewOrNull(pickNextWeeklyOff(rows, today)),
      history: toWeeklyOffHistory(rows),
    };
  }

  /**
   * PUT /attendance/weekly-offs — FR-18 tenant default via the AD-8 RPC
   * (exclusive tenant lock inside). An empty days array clears from
   * effectiveFrom onward. Responds with the resolved default (superset of
   * the I/O matrix's "resolved default": current + next + history).
   */
  async setWeeklyOffDefault(
    user: RequestUser,
    dto: SetWeeklyOffDefaultDto,
  ): Promise<WeeklyOffDefaultResponse> {
    const tenantId = requireTenant(user);
    this.assertWorkingDayRemains(dto.days);
    const admin = this.supabaseClientFactory.createAdmin();

    const { error } = await admin.rpc('attendance_set_weekly_off_default', {
      p_tenant_id: tenantId,
      p_days: dto.days,
      p_effective_from: dto.effectiveFrom ?? null,
    });
    if (error) {
      this.throwRpcError(error, 'Failed to set weekly-off default');
    }
    return this.getWeeklyOffs(user);
  }

  /** GET /attendance/weekly-offs/overrides — per-employee current overrides. */
  async listOverrides(user: RequestUser): Promise<WeeklyOffOverrideResponse[]> {
    const tenantId = requireTenant(user);
    const admin = this.supabaseClientFactory.createAdmin();
    const today = await resolveTenantToday(admin, tenantId);

    const rows = await readOverrides(admin, tenantId);
    if (rows.length === 0) {
      return [];
    }

    const names = await readEmployeeNames(admin, tenantId, [
      ...new Set(rows.map((r) => r.employee_id as string)),
    ]);

    const byEmployee = new Map<string, WeeklyOffRow[]>();
    for (const row of rows) {
      const bucket = byEmployee.get(row.employee_id as string);
      if (bucket) {
        bucket.push(row);
      } else {
        byEmployee.set(row.employee_id as string, [row]);
      }
    }

    return [...byEmployee.entries()]
      .map(([employeeId, employeeRows]) => ({
        employeeId,
        employeeName: names.get(employeeId) ?? 'Unknown employee',
        current: toViewOrNull(pickCurrentWeeklyOff(employeeRows, today)),
        next: toViewOrNull(pickNextWeeklyOff(employeeRows, today)),
      }))
      .sort((a, b) => a.employeeName.localeCompare(b.employeeName));
  }

  /** PUT /attendance/weekly-offs/overrides/:employeeId — FR-19 override. */
  async setOverride(
    user: RequestUser,
    employeeId: string,
    dto: SetWeeklyOffOverrideDto,
  ): Promise<WeeklyOffOverrideResponse> {
    const tenantId = requireTenant(user);
    this.assertWorkingDayRemains(dto.days);
    const admin = this.supabaseClientFactory.createAdmin();

    const { error } = await admin.rpc('attendance_set_weekly_off_override', {
      p_tenant_id: tenantId,
      p_employee_id: employeeId,
      p_days: dto.days,
      p_effective_from: dto.effectiveFrom ?? null,
    });
    if (error) {
      this.throwRpcError(error, 'Failed to set weekly-off override');
    }
    return this.readOverrideDetail(admin, tenantId, employeeId);
  }

  /**
   * DELETE /attendance/weekly-offs/overrides/:employeeId — clip-without-
   * insert; from effectiveFrom the employee reads the tenant default. The
   * response shows the post-removal state (current null once nothing
   * covers today).
   */
  async removeOverride(
    user: RequestUser,
    employeeId: string,
    query: RemoveOverrideQueryDto,
  ): Promise<WeeklyOffOverrideResponse> {
    const tenantId = requireTenant(user);
    const admin = this.supabaseClientFactory.createAdmin();

    const { error } = await admin.rpc('attendance_remove_weekly_off_override', {
      p_tenant_id: tenantId,
      p_employee_id: employeeId,
      p_effective_from: query.effectiveFrom ?? null,
    });
    if (error) {
      this.throwRpcError(error, 'Failed to remove weekly-off override');
    }
    return this.readOverrideDetail(admin, tenantId, employeeId);
  }

  /** Post-write resolved state for one employee (current/next + name). */
  private async readOverrideDetail(
    admin: Admin,
    tenantId: string,
    employeeId: string,
  ): Promise<WeeklyOffOverrideResponse> {
    const today = await resolveTenantToday(admin, tenantId);
    const rows = await readOverrides(admin, tenantId, employeeId);
    const names = await readEmployeeNames(admin, tenantId, [employeeId]);
    return {
      employeeId,
      employeeName: names.get(employeeId) ?? 'Unknown employee',
      current: toViewOrNull(pickCurrentWeeklyOff(rows, today)),
      next: toViewOrNull(pickNextWeeklyOff(rows, today)),
    };
  }

  /**
   * FR-18's zero-working-days rule, mirrored pre-DB with the pinned
   * ATTENDANCE_NO_WORKING_DAYS code (the I/O matrix's contract — a
   * pipe-level cap would surface as generic VALIDATION_ERROR). After the
   * DTO's range + uniqueness checks, a 7-element array is exactly "all
   * seven days". The RPC's PT422 and the table CHECKs back this up.
   */
  private assertWorkingDayRemains(days: number[]): void {
    if (days.length === 7) {
      throw new HttpException(
        {
          error_code: ErrorCode.ATTENDANCE_NO_WORKING_DAYS,
          message: 'At least one working day must remain',
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
  }

  /**
   * Maps a supabase-js rpc error by its HINT (which names the ErrorCode):
   * PT404 variants → 404, the zero-working-days PT422 and the days-CHECK
   * backstop → 422, anything else → 500.
   */
  private throwRpcError(error: RpcError, fallback: string): never {
    if (error.hint === HINT_TENANT_NOT_FOUND) {
      throw tenantNotFoundError();
    }
    if (error.hint === HINT_EMPLOYEE_NOT_FOUND) {
      throw new NotFoundException({
        error_code: ErrorCode.ATTENDANCE_EMPLOYEE_NOT_FOUND,
        message: 'Employee not found',
      });
    }
    if (error.hint === HINT_NO_WORKING_DAYS || error.code === PG_CHECK_VIOLATION) {
      // FR-18: a 7-day selection leaves zero working days. The service's
      // pre-DB guard rejects these with the same code; this is the
      // RPC/DB backstop.
      throw new HttpException(
        {
          error_code: ErrorCode.ATTENDANCE_NO_WORKING_DAYS,
          message: 'At least one working day must remain',
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    this.logger.error('Weekly-off RPC failed:', { error });
    throw internalError(fallback);
  }
}

function toViewOrNull(row: WeeklyOffRow | null) {
  return row ? toWeeklyOffView(row) : null;
}
