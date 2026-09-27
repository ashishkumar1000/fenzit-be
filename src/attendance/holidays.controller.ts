import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { HolidaysService } from './holidays.service';
import {
  CreateHolidayDto,
  HolidayDateQueryDto,
  UpdateHolidayDto,
} from './dto/holiday.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Role } from '../common/enums/role.enum';
import { ErrorCode } from '../common/enums/error-code.enum';
import { UUID_PATTERN } from '../common/utils/uuid-pattern.util';
import type { RequestUser } from '../common/interfaces/request-user.interface';

/** Raw request — the patch-route date-immutability check reads the body. */
interface RawRequest {
  body?: Record<string, unknown>;
}

/**
 * FR-20 holiday routes (Epic 15, Story 15-5). Owner-only; day statuses that
 * consume holidays recompute on read (AD-10) in Epic 16. No idempotency
 * interceptor (AD-6 excludes attendance): the (tenant, date) unique makes a
 * retried add a 409, and the dedupe keys bound the notification fan-out.
 */
@ApiTags('Attendance')
@ApiBearerAuth()
@Controller('attendance/holidays')
export class HolidaysController {
  constructor(private readonly holidaysService: HolidaysService) {}

  /** Malformed :id → 400 VALIDATION_ERROR before any DB round trip. */
  private requireHolidayId(id: string): string {
    if (!UUID_PATTERN.test(id)) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid holiday id',
      });
    }
    return id;
  }

  /**
   * The global pipe strips unknown keys silently (forbidNonWhitelisted:
   * false), so UpdateHolidayDto — name-only — cannot itself reject a `date`
   * key. This check reads the raw body before the DTO survives: a date
   * change is remove + add (scope decision 2026-09-27), never a patch.
   */
  private rejectDateKey(req: RawRequest): void {
    if (req.body !== undefined && 'date' in req.body) {
      // 422, matching the global ValidationPipe's validation-failure status
      // (VALIDATION_PIPE_OPTIONS) — this is a validation failure by another
      // door: the update DTO simply does not accept `date`.
      throw new HttpException(
        {
          error_code: ErrorCode.VALIDATION_ERROR,
          message:
            'A holiday date cannot be changed — remove the holiday and add it on the new date',
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
  }

  @Get()
  @Roles(Role.OWNER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'List holidays, ascending by date (FE groups upcoming/past)',
  })
  @ApiResponse({ status: 200, description: 'Holidays (possibly empty list)' })
  @ApiResponse({
    status: 400,
    description: 'VALIDATION_ERROR — owner without a company (no tenantId)',
  })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — Technician JWT' })
  @ApiResponse({
    status: 404,
    description: 'ATTENDANCE_TENANT_NOT_FOUND — stale/unknown tenant',
  })
  listHolidays(@CurrentUser() user: RequestUser) {
    return this.holidaysService.listHolidays(user);
  }

  @Get('impact')
  @Roles(Role.OWNER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Preview holiday impact for a date — tracked employees (empty pre-15-7; leave impact arrives with Epic 17)',
  })
  @ApiResponse({
    status: 200,
    description: '{ date, affectedEmployees: [{ employeeId, employeeName }] }',
  })
  @ApiResponse({
    status: 400,
    description: 'VALIDATION_ERROR — owner without a company (no tenantId)',
  })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — Technician JWT' })
  @ApiResponse({ status: 404, description: 'ATTENDANCE_TENANT_NOT_FOUND' })
  getImpact(
    @CurrentUser() user: RequestUser,
    @Query() query: HolidayDateQueryDto,
  ) {
    return this.holidaysService.getImpact(user, query);
  }

  @Post()
  @Roles(Role.OWNER)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Add a holiday (past or future); future dates notify tracked employees',
  })
  @ApiResponse({ status: 201, description: '{ id, date, name }' })
  @ApiResponse({
    status: 400,
    description: 'VALIDATION_ERROR — owner without a company (no tenantId)',
  })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — Technician JWT' })
  @ApiResponse({ status: 404, description: 'ATTENDANCE_TENANT_NOT_FOUND' })
  @ApiResponse({ status: 409, description: 'ATTENDANCE_HOLIDAY_TAKEN' })
  @ApiResponse({ status: 422, description: 'Malformed date (ValidationPipe)' })
  createHoliday(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateHolidayDto,
  ) {
    return this.holidaysService.createHoliday(user, dto);
  }

  @Patch(':id')
  @Roles(Role.OWNER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rename a holiday (the date is immutable)' })
  @ApiResponse({ status: 200, description: '{ id, date, name }' })
  @ApiResponse({
    status: 422,
    description:
      'VALIDATION_ERROR — a `date` key in the body (date is immutable; remove + add)',
  })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — Technician JWT' })
  @ApiResponse({
    status: 404,
    description:
      'ATTENDANCE_HOLIDAY_NOT_FOUND (unknown holiday) or ATTENDANCE_TENANT_NOT_FOUND (stale/unknown tenant)',
  })
  updateHoliday(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Req() req: RawRequest,
    @Body() dto: UpdateHolidayDto,
  ) {
    this.rejectDateKey(req);
    return this.holidaysService.updateHoliday(
      user,
      this.requireHolidayId(id),
      dto,
    );
  }

  @Delete(':id')
  @Roles(Role.OWNER)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove a holiday; removed future dates notify tracked employees',
  })
  @ApiResponse({ status: 204, description: 'Removed' })
  @ApiResponse({
    status: 400,
    description: 'VALIDATION_ERROR — malformed id / no tenant',
  })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — Technician JWT' })
  @ApiResponse({
    status: 404,
    description:
      'ATTENDANCE_HOLIDAY_NOT_FOUND (unknown holiday) or ATTENDANCE_TENANT_NOT_FOUND (stale/unknown tenant)',
  })
  async removeHoliday(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
  ) {
    await this.holidaysService.removeHoliday(user, this.requireHolidayId(id));
  }
}
