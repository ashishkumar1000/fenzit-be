import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { WeeklyOffsService } from './weekly-offs.service';
import {
  RemoveOverrideQueryDto,
  SetWeeklyOffDefaultDto,
  SetWeeklyOffOverrideDto,
} from './dto/weekly-off.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Role } from '../common/enums/role.enum';
import { ErrorCode } from '../common/enums/error-code.enum';
import { UUID_PATTERN } from '../common/utils/uuid-pattern.util';
import type { RequestUser } from '../common/interfaces/request-user.interface';

/**
 * FR-18/FR-19 weekly-off routes (Epic 15, Story 15-5). Owner-only; the
 * day-context resolution that reads these tables arrives with 16-1, and
 * the employee-facing "my weekly offs" with 15-10/19-6. No idempotency
 * interceptor (AD-6 excludes attendance): every write is lock-serialised
 * and naturally repeatable (re-setting the same selection converges).
 */
@ApiTags('Attendance')
@ApiBearerAuth()
@Controller('attendance/weekly-offs')
export class WeeklyOffsController {
  constructor(private readonly weeklyOffsService: WeeklyOffsService) {}

  /** Malformed :employeeId → 400 VALIDATION_ERROR before any DB round trip. */
  private requireEmployeeId(id: string): string {
    if (!UUID_PATTERN.test(id)) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid employee id',
      });
    }
    return id;
  }

  @Get()
  @Roles(Role.OWNER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Tenant weekly-off default — current selection, pending edit, full history',
  })
  @ApiResponse({
    status: 200,
    description:
      '{ default, next, history } — default null = all 7 days working',
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
  getWeeklyOffs(@CurrentUser() user: RequestUser) {
    return this.weeklyOffsService.getWeeklyOffs(user);
  }

  @Put()
  @Roles(Role.OWNER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Set the tenant weekly-off default from effectiveFrom (default today); empty days clears from that date',
  })
  @ApiResponse({
    status: 200,
    description: 'Resolved default: { default, next, history }',
  })
  @ApiResponse({
    status: 400,
    description: 'VALIDATION_ERROR — owner without a company (no tenantId)',
  })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — Technician JWT' })
  @ApiResponse({ status: 404, description: 'ATTENDANCE_TENANT_NOT_FOUND' })
  @ApiResponse({
    status: 422,
    description:
      'ATTENDANCE_NO_WORKING_DAYS — a 7-day selection (ValidationPipe or RPC/DB backstop)',
  })
  setWeeklyOffDefault(
    @CurrentUser() user: RequestUser,
    @Body() dto: SetWeeklyOffDefaultDto,
  ) {
    return this.weeklyOffsService.setWeeklyOffDefault(user, dto);
  }

  @Get('overrides')
  @Roles(Role.OWNER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Per-employee weekly-off overrides with current/pending picks',
  })
  @ApiResponse({ status: 200, description: 'Overrides list (possibly empty)' })
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
  listOverrides(@CurrentUser() user: RequestUser) {
    return this.weeklyOffsService.listOverrides(user);
  }

  @Put('overrides/:employeeId')
  @Roles(Role.OWNER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Set one employee's override (replaces the default from effectiveFrom); empty days = works all 7 days",
  })
  @ApiResponse({
    status: 200,
    description: '{ employeeId, employeeName, current, next }',
  })
  @ApiResponse({
    status: 400,
    description: 'VALIDATION_ERROR — malformed employee id / no tenant',
  })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — Technician JWT' })
  @ApiResponse({
    status: 404,
    description:
      'ATTENDANCE_EMPLOYEE_NOT_FOUND (employee not a tenant member) or ATTENDANCE_TENANT_NOT_FOUND (stale/unknown tenant)',
  })
  @ApiResponse({ status: 422, description: 'ATTENDANCE_NO_WORKING_DAYS' })
  setOverride(
    @CurrentUser() user: RequestUser,
    @Param('employeeId') employeeId: string,
    @Body() dto: SetWeeklyOffOverrideDto,
  ) {
    return this.weeklyOffsService.setOverride(
      user,
      this.requireEmployeeId(employeeId),
      dto,
    );
  }

  @Delete('overrides/:employeeId')
  @Roles(Role.OWNER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Remove an override from effectiveFrom (default today) — the employee falls back to the tenant default',
  })
  @ApiResponse({
    status: 200,
    description:
      'Post-removal state: { employeeId, employeeName, current, next }',
  })
  @ApiResponse({
    status: 400,
    description: 'VALIDATION_ERROR — malformed employee id / no tenant',
  })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — Technician JWT' })
  @ApiResponse({
    status: 404,
    description:
      'ATTENDANCE_EMPLOYEE_NOT_FOUND (employee not a tenant member) or ATTENDANCE_TENANT_NOT_FOUND (stale/unknown tenant)',
  })
  removeOverride(
    @CurrentUser() user: RequestUser,
    @Param('employeeId') employeeId: string,
    @Query() query: RemoveOverrideQueryDto,
  ) {
    return this.weeklyOffsService.removeOverride(
      user,
      this.requireEmployeeId(employeeId),
      query,
    );
  }
}
