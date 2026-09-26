import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { OfficesService } from './offices.service';
import { CreateOfficeDto } from './dto/create-office.dto';
import { UpdateOfficeDto } from './dto/update-office.dto';
import { ListOfficesQueryDto } from './dto/list-offices-query.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Role } from '../common/enums/role.enum';
import { ErrorCode } from '../common/enums/error-code.enum';
import type { RequestUser } from '../common/interfaces/request-user.interface';

/**
 * FR-5 office management routes (Epic 15, Story 15-3). Owner-only; the
 * check-in side that reads offices arrives with Epic 16. No idempotency
 * interceptor (AD-6): create is FE-guarded, PATCH is naturally idempotent
 * and archive is lock-serialised.
 */
@ApiTags('Attendance')
@ApiBearerAuth()
@Controller('attendance/offices')
export class OfficesController {
  /** Postgres UUID shape — a malformed :id would reach PostgREST as 22P02 → 500. */
  private static readonly UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  constructor(private readonly officesService: OfficesService) {}

  /** Malformed :id → 400 VALIDATION_ERROR before any DB round trip. */
  private requireOfficeId(id: string): string {
    if (!OfficesController.UUID_PATTERN.test(id)) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid office id',
      });
    }
    return id;
  }

  @Get()
  @Roles(Role.OWNER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'List offices — each with the rule valid on today and a pending next rule',
  })
  @ApiResponse({ status: 200, description: 'Offices with current/next rules (empty list is fine)' })
  @ApiResponse({ status: 400, description: 'VALIDATION_ERROR — owner without a company (no tenantId)' })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — Technician JWT' })
  listOffices(
    @CurrentUser() user: RequestUser,
    @Query() query: ListOfficesQueryDto,
  ) {
    return this.officesService.listOffices(user, query.includeArchived === 'true');
  }

  @Get(':id')
  @Roles(Role.OWNER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Office detail — full effective-dated rules history' })
  @ApiResponse({ status: 200, description: 'Office with its rules, ascending' })
  @ApiResponse({ status: 404, description: 'Office not found (or belongs to another tenant)' })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — Technician JWT' })
  getOffice(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.officesService.getOffice(user, this.requireOfficeId(id));
  }

  @Post()
  @Roles(Role.OWNER)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create an office with its initial rule (valid from today)',
  })
  @ApiResponse({ status: 201, description: 'Office created with its seeded rule' })
  @ApiResponse({ status: 400, description: 'VALIDATION_ERROR — owner without a company (no tenantId)' })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — Technician JWT' })
  @ApiResponse({ status: 409, description: 'ATTENDANCE_OFFICE_NAME_TAKEN' })
  @ApiResponse({ status: 422, description: 'Out-of-range values (ValidationPipe or DB CHECK)' })
  createOffice(@CurrentUser() user: RequestUser, @Body() dto: CreateOfficeDto) {
    return this.officesService.createOffice(user, dto);
  }

  @Patch(':id')
  @Roles(Role.OWNER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Edit name/pin/radius (immediate) and/or timing/hours rules (effective from tomorrow)',
  })
  @ApiResponse({ status: 200, description: 'Office updated; response carries the full rules history' })
  @ApiResponse({ status: 400, description: 'VALIDATION_ERROR — nothing to update, or partial rules set' })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — Technician JWT' })
  @ApiResponse({ status: 404, description: 'Office not found (or archived)' })
  @ApiResponse({ status: 409, description: 'ATTENDANCE_OFFICE_NAME_TAKEN' })
  @ApiResponse({ status: 422, description: 'Out-of-range values (ValidationPipe or DB CHECK)' })
  updateOffice(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: UpdateOfficeDto,
  ) {
    return this.officesService.updateOffice(user, this.requireOfficeId(id), dto);
  }

  @Post(':id/archive')
  @Roles(Role.OWNER)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Archive an office (never deleted) — blocked by tracked employees with assignments',
  })
  @ApiResponse({ status: 204, description: 'Archived (idempotent — already-archived is a no-op)' })
  @ApiResponse({ status: 400, description: 'VALIDATION_ERROR — owner without a company (no tenantId)' })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — Technician JWT' })
  @ApiResponse({ status: 404, description: 'Office not found' })
  @ApiResponse({
    status: 409,
    description: 'ATTENDANCE_OFFICE_ARCHIVE_BLOCKED — body carries blockers: [{employeeId, employeeName}]',
  })
  async archiveOffice(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.officesService.archiveOffice(user, this.requireOfficeId(id));
  }

  @Get(':id/archive/preview')
  @Roles(Role.OWNER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Preview: who blocks archiving this office (AD-24)',
  })
  @ApiResponse({ status: 200, description: '{ officeId, blockers: [...] } — empty list means free to archive' })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — Technician JWT' })
  @ApiResponse({ status: 404, description: 'Office not found' })
  getArchiveBlockers(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.officesService.getArchiveBlockers(user, this.requireOfficeId(id));
  }
}

