import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { MeAttendanceService } from './me-attendance.service';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Role } from '../common/enums/role.enum';
import type { RequestUser } from '../common/interfaces/request-user.interface';

/**
 * Technician-facing attendance reads (15-7). The employee id comes ONLY
 * from the JWT (`@CurrentUser`) — never from the client (NFR-1). Access
 * state comes from the attendance_access_state view — the same rows the
 * /users/me mirror reads — so the app cannot see a state the server
 * disagrees with (AD-17).
 */
@ApiTags('Attendance')
@ApiBearerAuth()
@Controller('attendance/me')
export class MeAttendanceController {
  constructor(private readonly meAttendanceService: MeAttendanceService) {}

  @Get('access')
  @Roles(Role.TECHNICIAN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'This employee’s attendance access — the entry-point gate (FR-3): none | upcoming | active | history_only',
  })
  @ApiResponse({
    status: 200,
    description:
      '{ attendanceEnabled, attendanceAccess, attendanceStartDate, enabledAt, onboardedAt, officeId, officeName }. The kill switch forces none; upcoming carries attendanceStartDate.',
  })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  getAccess(@CurrentUser() user: RequestUser) {
    return this.meAttendanceService.getAccess(user);
  }

  @Get('summary')
  @Roles(Role.TECHNICIAN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'This employee’s attendance summary (FR-4): office, timings, late cut-off, weekly offs — active/upcoming only',
  })
  @ApiResponse({
    status: 200,
    description:
      '{ officeId, officeName, startTime, endTime, lateCutOffMinutes, weeklyOffDays }. Office and the effective date come from the same access-state view row me/access reads, so the two can never disagree. Times are HH:mm (12-hour rendering is the app\'s); weeklyOffDays are ISO weekday numbers 1=Mon..7=Sun ([] = no weekly offs). none/history_only answer honestly empty.',
  })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  getSummary(@CurrentUser() user: RequestUser) {
    return this.meAttendanceService.getSummary(user);
  }

  @Post('onboarding')
  @Roles(Role.TECHNICIAN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Record FR-4 onboarding completion (once per employee; replays are idempotent)',
  })
  @ApiResponse({
    status: 200,
    description: '{ onboardedAt } — the first completion time, also on replays',
  })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  markOnboarded(@CurrentUser() user: RequestUser) {
    return this.meAttendanceService.markOnboarded(user);
  }
}
