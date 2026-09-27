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
