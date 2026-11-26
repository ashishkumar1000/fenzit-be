import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { HolidaysService } from './holidays.service';
import {
  HOLIDAY_TEMPLATE_FILENAME,
  HOLIDAY_TEMPLATE_MIME,
} from './holidays-bulk';
import {
  CreateHolidayDto,
  HolidayDateQueryDto,
  HolidayOverviewQueryDto,
  UpdateHolidayDto,
} from './dto/holiday.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ErrorCode } from '../common/enums/error-code.enum';
import { UUID_PATTERN } from '../common/utils/uuid-pattern.util';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { Can } from '../common/decorators/can.decorator';

/**
 * FR-20 holiday routes (Epic 15, Story 15-5; console redesign 2026-11-26).
 * Company-admin only; day statuses that consume holidays recompute on read
 * (AD-10). No idempotency interceptor (AD-6 excludes attendance): the
 * (tenant, date) unique makes a retried add a 409, and the notification
 * dedupe keys bound the fan-out.
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

  @Get()
  @Can('attendance.read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'List holidays, ascending by date (FE groups upcoming/past)',
  })
  @ApiResponse({
    status: 200,
    description: 'Holidays (possibly empty list), each with scope + officeIds',
  })
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

  @Get('overview')
  @Can('attendance.read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Year view for the console — holidays with offices + current staff per office',
  })
  @ApiResponse({
    status: 200,
    description:
      '{ year, holidays, offices: [{ officeId, name, staffCount }], unassignedCount }',
  })
  @ApiResponse({
    status: 400,
    description:
      'VALIDATION_ERROR — owner without a company (no tenantId), or a year before 0001',
  })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — Technician JWT' })
  @ApiResponse({ status: 404, description: 'ATTENDANCE_TENANT_NOT_FOUND' })
  getOverview(
    @CurrentUser() user: RequestUser,
    @Query() query: HolidayOverviewQueryDto,
  ) {
    return this.holidaysService.getOverview(user, query);
  }

  @Get('impact')
  @Can('attendance.read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Holiday + impact facts for a date — approved-leave overlap (the shipped affectedEmployees list) + per-office staff counts',
  })
  @ApiResponse({
    status: 200,
    description:
      '{ date, affectedEmployees, holiday (null on a plain date), approvedLeaveCount, trackedCount, perOffice, unassignedCount }',
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
  @Can('attendance.manage')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Add a holiday (all offices or named offices); future dates notify the covered offices',
  })
  @ApiResponse({ status: 201, description: '{ id, date, name, description, scope, officeIds }' })
  @ApiResponse({
    status: 400,
    description: 'VALIDATION_ERROR — owner without a company (no tenantId)',
  })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — Technician JWT' })
  @ApiResponse({ status: 404, description: 'ATTENDANCE_TENANT_NOT_FOUND' })
  @ApiResponse({ status: 409, description: 'ATTENDANCE_HOLIDAY_TAKEN' })
  @ApiResponse({
    status: 422,
    description: 'Malformed date / scope-office mismatch (ValidationPipe)',
  })
  createHoliday(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateHolidayDto,
  ) {
    return this.holidaysService.createHoliday(user, dto);
  }

  @Get('bulk-template')
  @Can('attendance.manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Download the bulk-upload .xlsx sheet — a Holidays sheet plus a Reference sheet listing the tenant's office names",
  })
  @ApiResponse({ status: 200, description: 'The .xlsx file (binary)' })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — Technician JWT' })
  @ApiResponse({ status: 404, description: 'ATTENDANCE_TENANT_NOT_FOUND' })
  async downloadBulkTemplate(
    @CurrentUser() user: RequestUser,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const file = await this.holidaysService.buildBulkTemplate(user);
    reply
      .type(HOLIDAY_TEMPLATE_MIME)
      .header(
        'content-disposition',
        `attachment; filename="${HOLIDAY_TEMPLATE_FILENAME}"`,
      )
      .send(file);
  }

  @Post('bulk')
  @Can('attendance.manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Upload the filled .xlsx sheet — every row is checked first, ONE bad row creates nothing (422 names the rows); a clean sheet creates new dates and updates known ones in place, one transaction. Bulk stays silent (no notifications).',
  })
  @ApiResponse({
    status: 200,
    description:
      '{ created, updated, skipped, holidays, updates } — new rows created, known dates updated in place, unchanged rows skipped',
  })
  @ApiResponse({
    status: 400,
    description: 'VALIDATION_ERROR — no/empty file body',
  })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — Technician JWT' })
  @ApiResponse({
    status: 413,
    description: 'Sheet over the body size limit',
  })
  @ApiResponse({
    status: 422,
    description:
      'ATTENDANCE_HOLIDAY_BULK_INVALID — { errors: [{ row, date, name, message }] }, nothing created',
  })
  bulkCreateHolidays(
    @CurrentUser() user: RequestUser,
    @Req() request: FastifyRequest,
  ) {
    // The raw body rides the scoped xlsx content-type parser (main.ts).
    const file = request.body;
    if (!(file instanceof Buffer) || file.length === 0) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Upload the filled .xlsx sheet to add holidays.',
      });
    }
    return this.holidaysService.bulkCreateHolidays(user, file);
  }

  @Patch(':id')
  @Can('attendance.manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Edit any holiday field incl. the date (taken target date → 409); omitted fields keep their values',
  })
  @ApiResponse({
    status: 200,
    description: '{ id, date, name, description, scope, officeIds }',
  })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — Technician JWT' })
  @ApiResponse({
    status: 404,
    description:
      'ATTENDANCE_HOLIDAY_NOT_FOUND (unknown holiday) or ATTENDANCE_TENANT_NOT_FOUND (stale/unknown tenant)',
  })
  @ApiResponse({ status: 409, description: 'ATTENDANCE_HOLIDAY_TAKEN' })
  @ApiResponse({
    status: 422,
    description: 'Malformed date / scope-office mismatch (ValidationPipe)',
  })
  updateHoliday(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: UpdateHolidayDto,
  ) {
    return this.holidaysService.updateHoliday(
      user,
      this.requireHolidayId(id),
      dto,
    );
  }

  @Delete(':id')
  @Can('attendance.manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Remove a holiday; removed future dates notify the offices it covered',
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
