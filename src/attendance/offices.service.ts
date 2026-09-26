import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { ErrorCode } from '../common/enums/error-code.enum';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { CreateOfficeDto } from './dto/create-office.dto';
import { UpdateOfficeDto } from './dto/update-office.dto';
import {
  ArchiveBlockersResponse,
  AttendanceOfficeRow,
  AttendanceOfficeRuleRow,
  OfficeDetailResponse,
  OfficeResponse,
  OfficeRuleResponse,
  pickCurrentRule,
  pickNextRule,
  toOfficeDetailResponse,
  toOfficeRuleResponse,
} from './offices-response.model';

/**
 * SQLSTATEs raised by the attendance office RPCs (PTxxx convention: last 3
 * digits = HTTP status). The HINT on each SQL error names the ErrorCode.
 * 23505 (unique) and 23514 (CHECK) are Postgres codes the DB's own
 * constraints raise; create_office re-raises the name clash as PT409.
 */
const HINT_TENANT_NOT_FOUND = 'ATTENDANCE_TENANT_NOT_FOUND';
const HINT_OFFICE_NOT_FOUND = 'ATTENDANCE_OFFICE_NOT_FOUND';
const HINT_NAME_TAKEN = 'ATTENDANCE_OFFICE_NAME_TAKEN';
const PG_UNIQUE_VIOLATION = '23505';
const PG_CHECK_VIOLATION = '23514';
const PG_NUMERIC_OUT_OF_RANGE = '22003';

type Admin = ReturnType<SupabaseClientFactory['createAdmin']>;

@Injectable()
export class OfficesService {
  private readonly logger = new Logger(OfficesService.name);

  constructor(
    private readonly supabaseClientFactory: SupabaseClientFactory,
  ) {}

  /**
   * FR-5 list. The rule valid on today is picked from the office's few
   * fetched ranges against attendance_today — "today" only from that helper
   * (AD-7); the earliest future rule shows a pending rules edit.
   */
  async listOffices(
    user: RequestUser,
    includeArchived = false,
  ): Promise<OfficeResponse[]> {
    const tenantId = this.requireTenant(user);
    const admin = this.supabaseClientFactory.createAdmin();
    const today = await this.today(admin, tenantId);

    let query = admin
      .from('attendance_offices')
      .select('*')
      .eq('tenant_id', tenantId);
    if (!includeArchived) {
      query = query.is('archived_at', null);
    }
    const { data: offices, error } = await query.order('name');
    if (error) {
      this.logger.error('Failed to list attendance offices:', { error });
      throw this.internalError('Failed to list offices');
    }

    const ids = (offices ?? []).map((o) => o.id);
    if (ids.length === 0) {
      return [];
    }
    const rulesByOffice = await this.readRulesForOffices(admin, user, ids);
    return (offices as AttendanceOfficeRow[]).map((office) => {
      const rules = rulesByOffice.get(office.id) ?? [];
      return {
        id: office.id,
        name: office.name,
        latitude: office.latitude,
        longitude: office.longitude,
        radiusM: office.radius_m,
        archivedAt: office.archived_at,
        rule: toRuleOrNull(pickCurrentRule(rules, today)),
        nextRule: toRuleOrNull(pickNextRule(rules, today)),
      };
    });
  }

  /** Full effective-dated history for one office (the edit screen's source). */
  async getOffice(user: RequestUser, officeId: string): Promise<OfficeDetailResponse> {
    this.requireTenant(user);
    const admin = this.supabaseClientFactory.createAdmin();
    const office = await this.readOffice(admin, user, officeId);
    const rules = await this.readAllRules(admin, user, officeId);
    return toOfficeDetailResponse(office, rules);
  }

  /**
   * FR-5 create: two row-sets (office + initial rule valid [today, ∞)) —
   * one RPC (AD-3). Re-reads the seeded rule so the response carries it.
   */
  async createOffice(user: RequestUser, dto: CreateOfficeDto): Promise<OfficeResponse> {
    const tenantId = this.requireTenant(user);
    const admin = this.supabaseClientFactory.createAdmin();
    const today = await this.today(admin, tenantId);

    const { data, error } = await admin.rpc('attendance_create_office', {
      p_tenant_id: tenantId,
      p_actor_id: user.userId,
      p_name: dto.name,
      p_latitude: dto.latitude,
      p_longitude: dto.longitude,
      p_radius_m: dto.radiusM,
      p_start_time: dto.startTime,
      p_end_time: dto.endTime,
      p_late_cutoff_minutes: dto.lateCutoffMinutes,
      p_full_day_hours: dto.fullDayHours,
      p_half_day_hours: dto.halfDayHours,
    });
    if (error) {
      this.throwRpcError(error, 'Failed to create office');
    }
    if (!data) {
      this.logger.error('attendance_create_office resolved with no office id');
      throw this.internalError('Failed to create office');
    }

    const office = await this.readOffice(admin, user, data as string);
    const rules =
      (await this.readRulesForOffices(admin, user, [office.id])).get(office.id) ?? [];
    return {
      id: office.id,
      name: office.name,
      latitude: office.latitude,
      longitude: office.longitude,
      radiusM: office.radius_m,
      archivedAt: office.archived_at,
      rule: toRuleOrNull(pickCurrentRule(rules, today)),
      nextRule: null,
    };
  }

  /**
   * One PATCH route (user decision 2026-09-26) with an internal split:
   * profile fields → guarded single-row UPDATE (not effective-dated);
   * rules fields → attendance_update_office_rules (effective from tomorrow,
   * the AD-8 algorithm). Rules fields must travel as a complete set of five.
   */
  async updateOffice(
    user: RequestUser,
    officeId: string,
    dto: UpdateOfficeDto,
  ): Promise<OfficeDetailResponse> {
    const tenantId = this.requireTenant(user);
    const admin = this.supabaseClientFactory.createAdmin();

    const profile = {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.latitude !== undefined ? { latitude: dto.latitude } : {}),
      ...(dto.longitude !== undefined ? { longitude: dto.longitude } : {}),
      ...(dto.radiusM !== undefined ? { radius_m: dto.radiusM } : {}),
    };
    const rules = {
      ...(dto.startTime !== undefined ? { p_start_time: dto.startTime } : {}),
      ...(dto.endTime !== undefined ? { p_end_time: dto.endTime } : {}),
      ...(dto.lateCutoffMinutes !== undefined
        ? { p_late_cutoff_minutes: dto.lateCutoffMinutes }
        : {}),
      ...(dto.fullDayHours !== undefined ? { p_full_day_hours: dto.fullDayHours } : {}),
      ...(dto.halfDayHours !== undefined ? { p_half_day_hours: dto.halfDayHours } : {}),
    };

    if (Object.keys(rules).length > 0 && Object.keys(rules).length !== 5) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message:
          'Rules must be sent as a complete set: startTime, endTime, lateCutoffMinutes, fullDayHours, halfDayHours',
      });
    }
    if (Object.keys(profile).length === 0 && Object.keys(rules).length === 0) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Nothing to update',
      });
    }

    if (Object.keys(profile).length > 0) {
      // Guarded UPDATE (AD-3 single-row exception): tenant + not-archived
      // filter; an empty result is the unambiguous 404. A rename hitting the
      // unique name index raises 23505 → 409 name taken.
      const { data, error } = await admin
        .from('attendance_offices')
        .update(profile)
        .eq('id', officeId)
        .eq('tenant_id', tenantId)
        .is('archived_at', null)
        .select('id');
      if (error) {
        if (error.code === PG_UNIQUE_VIOLATION) {
          throw this.conflict(
            ErrorCode.ATTENDANCE_OFFICE_NAME_TAKEN,
            'An office with this name already exists',
          );
        }
        this.logger.error('Failed to update office profile:', { error });
        throw this.internalError('Failed to update office');
      }
      if (!data || data.length === 0) {
        throw new NotFoundException({
          error_code: ErrorCode.ATTENDANCE_OFFICE_NOT_FOUND,
          message: 'Office not found',
        });
      }
    }

    if (Object.keys(rules).length === 5) {
      const { error } = await admin.rpc('attendance_update_office_rules', {
        p_tenant_id: tenantId,
        p_actor_id: user.userId,
        p_office_id: officeId,
        ...rules,
      });
      if (error) {
        this.throwRpcError(error, 'Failed to update office rules');
      }
    }

    const updated = await this.readOffice(admin, user, officeId);
    const rulesHistory = await this.readAllRules(admin, user, officeId);
    return toOfficeDetailResponse(updated, rulesHistory);
  }

  /**
   * FR-5 archive: attendance_archive_office takes the exclusive tenant
   * lock and is blocked by tracked employees with assignments (AD-25). On
   * PT409 the blocker list is assembled from the preview function — the
   * same read the GET …/archive/preview route serves (AD-24). Resolves to
   * null on success (204).
   */
  async archiveOffice(user: RequestUser, officeId: string): Promise<null> {
    const tenantId = this.requireTenant(user);
    const admin = this.supabaseClientFactory.createAdmin();

    const { error } = await admin.rpc('attendance_archive_office', {
      p_tenant_id: tenantId,
      p_actor_id: user.userId,
      p_office_id: officeId,
    });
    if (error) {
      if (error.code === 'PT409') {
        // The only PT409 this RPC raises: tracked employees assigned. The
        // conflict is already established — a failing blockers read degrades
        // to an empty list rather than masking the 409 with a 500.
        let blockers: ArchiveBlockersResponse['blockers'];
        try {
          blockers = await this.readBlockers(admin, user, officeId);
        } catch {
          blockers = [];
        }
        throw new HttpException(
          {
            error_code: ErrorCode.ATTENDANCE_OFFICE_ARCHIVE_BLOCKED,
            message: 'Office has tracked employees assigned',
            blockers,
          },
          HttpStatus.CONFLICT,
        );
      }
      this.throwRpcError(error, 'Failed to archive office');
    }
    return null;
  }

  /** AD-24 preview: who blocks archiving this office. */
  async getArchiveBlockers(user: RequestUser, officeId: string): Promise<ArchiveBlockersResponse> {
    this.requireTenant(user);
    const admin = this.supabaseClientFactory.createAdmin();
    await this.readOffice(admin, user, officeId);
    return {
      officeId,
      blockers: await this.readBlockers(admin, user, officeId),
    };
  }

  private async readBlockers(
    admin: Admin,
    user: RequestUser,
    officeId: string,
  ): Promise<ArchiveBlockersResponse['blockers']> {
    const { data, error } = await admin.rpc('attendance_office_archive_blockers', {
      p_tenant_id: user.tenantId as string,
      p_office_id: officeId,
    });
    if (error) {
      this.throwRpcError(error, 'Failed to read archive blockers');
    }
    return (data ?? []).map(
      (row: { employee_id: string; employee_name: string }) => ({
        employeeId: row.employee_id,
        employeeName: row.employee_name,
      }),
    );
  }

  /**
   * All effective-dated rules for the given offices, grouped by office id.
   * An office's history is small (one row per rules edit); the current /
   * next-rule picks happen in the response model against `today`.
   */
  private async readRulesForOffices(
    admin: Admin,
    user: RequestUser,
    officeIds: string[],
  ): Promise<Map<string, AttendanceOfficeRuleRow[]>> {
    const { data, error } = await admin
      .from('attendance_office_rules')
      .select('*')
      .eq('tenant_id', user.tenantId as string)
      .in('office_id', officeIds);
    if (error) {
      this.logger.error('Failed to read attendance office rules:', { error });
      throw this.internalError('Failed to read office rules');
    }
    const byOffice = new Map<string, AttendanceOfficeRuleRow[]>();
    for (const row of (data ?? []) as AttendanceOfficeRuleRow[]) {
      const bucket = byOffice.get(row.office_id);
      if (bucket) {
        bucket.push(row);
      } else {
        byOffice.set(row.office_id, [row]);
      }
    }
    return byOffice;
  }

  private async readAllRules(
    admin: Admin,
    user: RequestUser,
    officeId: string,
  ): Promise<AttendanceOfficeRuleRow[]> {
    const { data, error } = await admin
      .from('attendance_office_rules')
      .select('*')
      .eq('office_id', officeId)
      .eq('tenant_id', user.tenantId as string);
    if (error) {
      this.logger.error('Failed to read attendance office rules:', { error });
      throw this.internalError('Failed to read office rules');
    }
    return data ?? [];
  }

  private async readOffice(
    admin: Admin,
    user: RequestUser,
    officeId: string,
  ): Promise<AttendanceOfficeRow> {
    const { data, error } = await admin
      .from('attendance_offices')
      .select('*')
      .eq('id', officeId)
      .eq('tenant_id', user.tenantId as string)
      .maybeSingle<AttendanceOfficeRow>();
    if (error) {
      this.logger.error('Failed to read attendance office:', { error });
      throw this.internalError('Failed to read office');
    }
    if (!data) {
      throw new NotFoundException({
        error_code: ErrorCode.ATTENDANCE_OFFICE_NOT_FOUND,
        message: 'Office not found',
      });
    }
    return data;
  }

  /** The only source of "today" (AD-7) — server clock in the tenant timezone. */
  private async today(admin: Admin, tenantId: string): Promise<string> {
    const { data, error } = await admin.rpc('attendance_today', {
      p_tenant_id: tenantId,
    });
    if (error) {
      this.throwRpcError(error, 'Failed to resolve tenant date');
    }
    return data as string;
  }

  private requireTenant(user: RequestUser): string {
    if (!user.tenantId) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Company setup required before using attendance',
      });
    }
    return user.tenantId;
  }

  /**
   * Maps a supabase-js rpc error by its HINT (which names the ErrorCode):
   * PT404 variants → 404, 23514/22003 → 422, anything else → 500. Archive's
   * PT409 (blockers) is handled at its call site before this runs.
   */
  private throwRpcError(
    error: { code?: string; hint?: string; message: string },
    fallback: string,
  ): never {
    if (error.hint === HINT_TENANT_NOT_FOUND) {
      throw new NotFoundException({
        error_code: ErrorCode.ATTENDANCE_TENANT_NOT_FOUND,
        message: 'Company setup required before using attendance',
      });
    }
    if (error.hint === HINT_OFFICE_NOT_FOUND) {
      throw new NotFoundException({
        error_code: ErrorCode.ATTENDANCE_OFFICE_NOT_FOUND,
        message: 'Office not found',
      });
    }
    if (error.hint === HINT_NAME_TAKEN) {
      throw this.conflict(
        ErrorCode.ATTENDANCE_OFFICE_NAME_TAKEN,
        'An office with this name already exists',
      );
    }
    if (error.code === PG_CHECK_VIOLATION || error.code === PG_NUMERIC_OUT_OF_RANGE) {
      // Range violations are 422 VALIDATION_ERROR per the I/O matrix — the
      // DTO mirrors reject early, this catches what slips past the pipe.
      throw new HttpException(
        {
          error_code: ErrorCode.VALIDATION_ERROR,
          message: 'Office rule values violate the allowed ranges',
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    this.logger.error('Attendance office RPC failed:', { error });
    throw this.internalError(fallback);
  }

  private conflict(errorCode: ErrorCode, message: string): HttpException {
    return new HttpException(
      { error_code: errorCode, message },
      HttpStatus.CONFLICT,
    );
  }

  private internalError(message: string): InternalServerErrorException {
    return new InternalServerErrorException({
      error_code: ErrorCode.INTERNAL_SERVER_ERROR,
      message,
    });
  }
}

function toRuleOrNull(row: AttendanceOfficeRuleRow | null): OfficeRuleResponse | null {
  return row ? toOfficeRuleResponse(row) : null;
}