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
import { DashboardQueryDto } from './dto/dashboard-query.dto';
import { DashboardService } from './dashboard';

/**
 * 19-2's owner dashboard route (spec D5) — FR-24's five tiles + the two
 * unresolved-past-flag strips, all derived from ONE engine grid read
 * (`readDayStatusGrid` over today's rows). Today only — no date params:
 * the tiles are a snapshot of `attendance_today()` (FR-24). No
 * idempotency header (AD-6's letter, the 18-2 read precedent).
 */
@ApiTags('Attendance')
@ApiBearerAuth()
@Controller('attendance')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('dashboard')
  @Roles(Role.OWNER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'FR-24 today’s tiles (tracked / checkedIn / notCheckedIn / late / onLeave) and the unresolved flags (checkout-missing, mocked attempts)',
  })
  @ApiResponse({
    status: 200,
    description:
      '{ date, counts: { tracked, checkedIn, notCheckedIn, late, onLeave }, flags: { checkoutMissing[], fakeLocationAttempt[] } } — the tiles PARTITION tracked (bucket follows the calendar grade: checkedIn = in_progress|present|half_day|worked_on_holiday; onLeave = leave|half_day_leave; notCheckedIn = everything else, incl. weekly_off/holiday and any `absent`); late counts only inside checkedIn',
  })
  @ApiResponse({
    status: 422,
    description:
      'VALIDATION_ERROR (malformed officeId) — an UNKNOWN-but-well-formed officeId is a 200 with zeros + empty flags, never a 404',
  })
  today(
    @CurrentUser() owner: RequestUser,
    @Query() query: DashboardQueryDto,
  ) {
    return this.dashboard.today(owner, query.officeId);
  }
}
