import { Controller, Get, HttpCode, HttpStatus, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Role } from '../common/enums/role.enum';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { DayStatusesService } from './day-status.read';
import { DayStatusesQueryDto, MeDayStatusesQueryDto } from './dto/correction.dto';

/**
 * The day-statuses reads (18-1) — the single implementation every Epic 18
 * surface (and the Epic 19 aggregates) reads rows from. Each method
 * carries its own @Roles (the owner route OWNER, the `me` route a
 * method-level TECHNICIAN override — RolesGuard getAllAndOverride). Both
 * run `validateDayStatusRange` first (from ≤ to, span ≤ 62 → 422) BEFORE
 * the service transaction — the span-cap DoS lesson keeps the cap off the
 * transaction pool.
 */
@ApiTags('Attendance')
@ApiBearerAuth()
@Controller('attendance')
export class DayStatusesController {
  constructor(private readonly dayStatusesService: DayStatusesService) {}

  @Get('day-statuses')
  @Roles(Role.OWNER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'FR-10 one employee’s statuses for a range (the 12-key vocabulary + FR-11 credits + markers; from ≤ to, span ≤ 62 days)',
  })
  @ApiResponse({
    status: 200,
    description: '{ employeeId, from, to, days: DayStatusRow[] } — every date of the range, oldest first',
  })
  @ApiResponse({
    status: 404,
    description: 'ATTENDANCE_EMPLOYEE_NOT_FOUND — employee outside this tenant (no existence leak)',
  })
  @ApiResponse({
    status: 422,
    description: 'ATTENDANCE_INVALID_RANGE (from > to, or span > 62 days)',
  })
  list(
    @CurrentUser() owner: RequestUser,
    @Query() query: DayStatusesQueryDto,
  ) {
    return this.dayStatusesService.listForOwner(
      owner,
      query.employeeId,
      query.from,
      query.to,
    );
  }

  @Get('me/day-statuses')
  @Roles(Role.TECHNICIAN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'FR-10 my day statuses for a range (identity from the JWT; AD-17 gate: none → 403)',
  })
  @ApiResponse({
    status: 200,
    description: '{ from, to, days: DayStatusRow[] }',
  })
  @ApiResponse({
    status: 403,
    description: 'ATTENDANCE_NOT_TRACKED — attendance not active for this employee',
  })
  listMine(
    @CurrentUser() user: RequestUser,
    @Query() query: MeDayStatusesQueryDto,
  ) {
    return this.dayStatusesService.listMine(user, query.from, query.to);
  }
}
