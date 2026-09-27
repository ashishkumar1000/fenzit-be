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
  CreateHolidayDto,
  HolidayDateQueryDto,
  UpdateHolidayDto,
} from './dto/holiday.dto';
import {
  Admin,
  HINT_HOLIDAY_NOT_FOUND,
  HINT_HOLIDAY_TAKEN,
  HINT_TENANT_NOT_FOUND,
  internalError,
  requireTenant,
  resolveTenantToday,
  tenantNotFoundError,
  type RpcError,
} from './attendance-rpc.helpers';

/** holidays row (snake_case, DB shape). */
export interface HolidayRow {
  id: string;
  tenant_id: string;
  holiday_date: string;
  name: string;
  created_at: string;
  updated_at: string;
}

/** Holiday responses travel camelCase: { id, date, name }. */
export interface HolidayResponse {
  id: string;
  date: string;
  name: string;
}

/** GET /attendance/holidays/impact — the AD-24 preview body. */
export interface HolidayImpactResponse {
  date: string;
  affectedEmployees: { employeeId: string; employeeName: string }[];
}

@Injectable()
export class HolidaysService {
  private readonly logger = new Logger(HolidaysService.name);

  constructor(private readonly supabaseClientFactory: SupabaseClientFactory) {}

  /**
   * GET /attendance/holidays — tenant-scoped, ascending by date; the FE
   * (15-6) groups upcoming/past client-side. attendance_today runs first so
   * a stale/unknown tenant fails loud 404 like every sibling read (review
   * harmonisation decision 2026-09-27) — the list itself doesn't need the
   * date (grouping is client-side), the uniform error contract does.
   */
  async listHolidays(user: RequestUser): Promise<HolidayResponse[]> {
    const tenantId = requireTenant(user);
    const admin = this.supabaseClientFactory.createAdmin();
    await resolveTenantToday(admin, tenantId);
    const { data, error } = await admin
      .from('holidays')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('holiday_date', { ascending: true });
    if (error) {
      this.logger.error('Failed to list holidays:', { error });
      throw internalError('Failed to list holidays');
    }
    return (data ?? []).map(toHolidayResponse);
  }

  /**
   * POST /attendance/holidays — attendance_add_holiday RPC. Future dates
   * fan notifications out to tracked employees in the same transaction
   * (pre-15-7 the recipient branch is a clean no-op — to_regclass guard).
   */
  async createHoliday(
    user: RequestUser,
    dto: CreateHolidayDto,
  ): Promise<HolidayResponse> {
    const tenantId = requireTenant(user);
    const admin = this.supabaseClientFactory.createAdmin();

    const { data, error } = await admin.rpc('attendance_add_holiday', {
      p_tenant_id: tenantId,
      p_holiday_date: dto.date,
      p_name: dto.name,
    });
    if (error) {
      this.throwRpcError(error, 'Failed to add holiday');
    }
    if (!data) {
      this.logger.error('attendance_add_holiday resolved with no holiday id');
      throw internalError('Failed to add holiday');
    }
    return {
      id: data as string,
      date: dto.date,
      name: dto.name,
    };
  }

  /** PATCH /attendance/holidays/:id — name only (date is immutable). */
  async updateHoliday(
    user: RequestUser,
    holidayId: string,
    dto: UpdateHolidayDto,
  ): Promise<HolidayResponse> {
    const tenantId = requireTenant(user);
    const admin = this.supabaseClientFactory.createAdmin();

    const { error } = await admin.rpc('attendance_update_holiday', {
      p_tenant_id: tenantId,
      p_holiday_id: holidayId,
      p_name: dto.name,
    });
    if (error) {
      this.throwRpcError(error, 'Failed to update holiday');
    }
    const holiday = await this.readHoliday(admin, tenantId, holidayId);
    return toHolidayResponse(holiday);
  }

  /**
   * DELETE /attendance/holidays/:id — hard delete; removed future holidays
   * notify tracked employees (pre-15-7 a clean no-op). Resolves to null
   * (204).
   */
  async removeHoliday(user: RequestUser, holidayId: string): Promise<null> {
    const tenantId = requireTenant(user);
    const admin = this.supabaseClientFactory.createAdmin();

    const { error } = await admin.rpc('attendance_remove_holiday', {
      p_tenant_id: tenantId,
      p_holiday_id: holidayId,
    });
    if (error) {
      this.throwRpcError(error, 'Failed to remove holiday');
    }
    return null;
  }

  /**
   * GET /attendance/holidays/impact?date= — the AD-24 preview the add/remove
   * confirmations show. Returns an empty list pre-15-7 (tracked employees
   * don't exist yet); employees on approved leave arrive with Epic 17.
   */
  async getImpact(
    user: RequestUser,
    query: HolidayDateQueryDto,
  ): Promise<HolidayImpactResponse> {
    const tenantId = requireTenant(user);
    const admin = this.supabaseClientFactory.createAdmin();

    const { data, error } = await admin.rpc('attendance_holiday_impact', {
      p_tenant_id: tenantId,
      p_date: query.date,
    });
    if (error) {
      this.throwRpcError(error, 'Failed to preview holiday impact');
    }
    return {
      date: query.date,
      affectedEmployees: (data ?? []).map(
        (row: { employee_id: string; employee_name: string }) => ({
          employeeId: row.employee_id,
          employeeName: row.employee_name,
        }),
      ),
    };
  }

  private async readHoliday(
    admin: Admin,
    tenantId: string,
    holidayId: string,
  ): Promise<HolidayRow> {
    const { data, error } = await admin
      .from('holidays')
      .select('*')
      .eq('id', holidayId)
      .eq('tenant_id', tenantId)
      .maybeSingle<HolidayRow>();
    if (error) {
      this.logger.error('Failed to read holiday:', { error });
      throw internalError('Failed to read holiday');
    }
    if (!data) {
      throw new NotFoundException({
        error_code: ErrorCode.ATTENDANCE_HOLIDAY_NOT_FOUND,
        message: 'Holiday not found',
      });
    }
    return data;
  }

  /** Maps a supabase-js rpc error by its HINT (which names the ErrorCode). */
  private throwRpcError(error: RpcError, fallback: string): never {
    if (error.hint === HINT_TENANT_NOT_FOUND) {
      throw tenantNotFoundError();
    }
    if (error.hint === HINT_HOLIDAY_TAKEN) {
      throw new HttpException(
        {
          error_code: ErrorCode.ATTENDANCE_HOLIDAY_TAKEN,
          message: 'A holiday on this date already exists',
        },
        HttpStatus.CONFLICT,
      );
    }
    if (error.hint === HINT_HOLIDAY_NOT_FOUND) {
      throw new NotFoundException({
        error_code: ErrorCode.ATTENDANCE_HOLIDAY_NOT_FOUND,
        message: 'Holiday not found',
      });
    }
    this.logger.error('Holiday RPC failed:', { error });
    throw internalError(fallback);
  }
}

function toHolidayResponse(row: HolidayRow): HolidayResponse {
  return { id: row.id, date: row.holiday_date, name: row.name };
}
