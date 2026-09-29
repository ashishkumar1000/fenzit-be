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
import {
  MeMonthlyQueryDto,
  MonthlyQueryDto,
} from './dto/monthly-query.dto';
import { MonthlyService } from './monthly';

/**
 * 19-3's monthly routes (spec D6) over ONE aggregation. Each method
 * carries its own @Roles (RolesGuard getAllAndOverride). Range checks run
 * BEFORE the service transaction (from/to format via the DTO; from ≤ to,
 * span ≤ 31, to ≤ tenant-today in the service → 422) — the span-cap DoS
 * lesson keeps the cap off the transaction pool.
 */
@ApiTags('Attendance')
@ApiBearerAuth()
@Controller('attendance')
export class MonthlyController {
  constructor(private readonly monthly: MonthlyService) {}

  @Get('monthly')
  @Roles(Role.OWNER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'FR-25 per-employee monthly summaries for a range (engine-derived credits; span ≤ 31 days, no future end dates)',
  })
  @ApiResponse({
    status: 200,
    description:
      '{ from, to, employees: [{ employeeId, employeeName, officeId, officeName, summary }] }',
  })
  @ApiResponse({
    status: 422,
    description:
      'ATTENDANCE_INVALID_RANGE (from > to, span > 31 days, or to after today) / VALIDATION_ERROR (malformed dates or officeId)',
  })
  list(
    @CurrentUser() owner: RequestUser,
    @Query() query: MonthlyQueryDto,
  ) {
    return this.monthly.forOwner(
      owner,
      query.from,
      query.to,
      query.officeId,
    );
  }

  @Get('me/monthly')
  @Roles(Role.TECHNICIAN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'FR-26 my monthly summary for a range, plus my weekly-off weekdays and the next 10 upcoming holidays (identity from the JWT; AD-17 gate: none → 403)',
  })
  @ApiResponse({
    status: 200,
    description:
      '{ from, to, summary, weeklyOffs, upcomingHolidays } — the same summary keys the owner sees (FR-11)',
  })
  @ApiResponse({
    status: 403,
    description: 'ATTENDANCE_NOT_TRACKED — attendance not active for you yet',
  })
  @ApiResponse({
    status: 422,
    description:
      'ATTENDANCE_INVALID_RANGE (from > to, span > 31 days, or to after today)',
  })
  listMine(
    @CurrentUser() user: RequestUser,
    @Query() query: MeMonthlyQueryDto,
  ) {
    return this.monthly.forMe(user, query.from, query.to);
  }
}
