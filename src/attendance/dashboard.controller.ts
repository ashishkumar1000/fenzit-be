import { Controller, Get, HttpCode, HttpStatus, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { DashboardQueryDto } from './dto/dashboard-query.dto';
import { TrendRangeDto } from './dto/trend-range.dto';
import { DashboardService } from './dashboard';
import { AttendanceTrendService } from './trend';
import { Can } from '../common/decorators/can.decorator';

/**
 * 19-2's owner dashboard route (spec D5) — FR-24's five tiles + the two
 * unresolved-past-flag strips, all derived from ONE engine grid read
 * (`readDayStatusGrid` over today's rows). Today only — no date params:
 * the tiles are a snapshot of `attendance_today()` (FR-24). No
 * idempotency header (AD-6's letter, the 18-2 read precedent).
 *
 * The 2026-11-27 exec dashboard adds `GET attendance/trend`: the SAME
 * engine partition evaluated per day over a window (see trend.ts).
 */
@ApiTags('Attendance')
@ApiBearerAuth()
@Controller('attendance')
export class DashboardController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly trendService: AttendanceTrendService,
  ) {}

  @Get('dashboard')
  @Can('attendance.read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'FR-24 today’s tiles (tracked / checkedIn / notCheckedIn / shortDay / late / onLeave) and the unresolved flags (checkout-missing, mocked attempts)',
  })
  @ApiResponse({
    status: 200,
    description:
      '{ date, counts: { tracked, checkedIn, notCheckedIn, shortDay, late, onLeave }, flags: { checkoutMissing[], fakeLocationAttempt[] } } — the four buckets PARTITION tracked (bucket follows the calendar grade, with shortDay split by the absent origin: checkedIn = in_progress|present|half_day|worked_on_holiday; onLeave = leave|half_day_leave; shortDay = the ENGINE-graded rule-7 `absent` (punch-in AND punch-out under the half-day threshold, no owner status override); notCheckedIn = everything else, incl. weekly_off/holiday, owner-adjudicated `absent` overrides and the past-no-check-in `absent`); late counts only inside checkedIn',
  })
  @ApiResponse({
    status: 422,
    description:
      'VALIDATION_ERROR (malformed officeId) — an UNKNOWN-but-well-formed officeId is a 200 with zeros + empty flags, never a 404',
  })
  today(@CurrentUser() owner: RequestUser, @Query() query: DashboardQueryDto) {
    return this.dashboard.today(owner, query.officeId);
  }

  // The exec dashboard's daily distribution (2026-11-27): the pulse's
  // partition over a whole window, one engine grid read. Same permission as
  // the tiles — the chart is the tiles over time, nothing broader.
  @Get('trend')
  @Can('attendance.read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Exec-dashboard attendance trend: the FR-24 bucket partition (tracked / checkedIn / notCheckedIn / shortDay / late / onLeave) for every day of a window, oldest first',
  })
  @ApiResponse({
    status: 200,
    description:
      '{ range: { from, to }, days: [{ date, tracked, checkedIn, notCheckedIn, shortDay, late, onLeave }] } — the same partition as /attendance/dashboard, per day; honest zeros on days nobody was tracked',
  })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({
    status: 422,
    description:
      'from/to not real YYYY-MM-DD dates, from after to, or the window longer than 62 days',
  })
  trend(@CurrentUser() owner: RequestUser, @Query() query: TrendRangeDto) {
    return this.trendService.trend(owner, query.from, query.to);
  }
}
