import {
  Body,
  Controller,
  Get,
  Headers,
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
import { CheckInOutService } from './check-in-out.service';
import { CheckInOutDto } from './dto/check-in-out.dto';
import { HttpException } from '@nestjs/common';
import { ErrorCode } from '../common/enums/error-code.enum';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Role } from '../common/enums/role.enum';
import type { RequestUser } from '../common/interfaces/request-user.interface';

/** AD-6: UUID v4, generated per user tap by the app. */
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  constructor(
    private readonly meAttendanceService: MeAttendanceService,
    private readonly checkInOutService: CheckInOutService,
  ) {}

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
      'This employee’s attendance summary (FR-4): office, timings, late cut-off, weekly offs, plus the Today extension (office pin, today’s day facts and record, 16-4) — active/upcoming only',
  })
  @ApiResponse({
    status: 200,
    description:
      "{ officeId, officeName, startTime, endTime, lateCutOffMinutes, weeklyOffDays, officeLatitude, officeLongitude, today, todayRecord }. Office and the effective date come from the same access-state view row me/access reads, so the two can never disagree. Times are HH:mm (12-hour rendering is the app's); weeklyOffDays are ISO weekday numbers 1=Mon..7=Sun ([] = no weekly offs). officeLatitude/Longitude are the office pin (display-only distance hint). today = { date, isWeeklyOff, isHoliday, holidayName, isWorkingDay, leaveState, leavePart } and todayRecord = { checkinAt, checkoutAt, lateMinutes, isLate, workedMinutes, earlyCheckout, earlyCheckoutMinutes } exist ONLY for active employees (null otherwise; todayRecord null when no record today); instants carry the tenant offset. leaveState is 'pending' | 'approved' | null — today's active leave (17-8), null when no live leave covers today (cancelled/revoked/none); leavePart mirrors the request's part ('full_day' | 'first_half' | 'second_half'), null with leaveState. none/history_only answer honestly empty.",
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

  @Post('check-in')
  @Roles(Role.TECHNICIAN)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'FR-7 check-in: geofenced, server-verified, idempotent (AD-4/5/6/15). Rejections are committed outcomes, not errors',
  })
  @ApiResponse({
    status: 201,
    description:
      '{ workDate, checkinAt (tenant-offset ISO), lateMinutes, isLate, dayContext }. Instants carry the tenant offset so the app never does timezone math',
  })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({
    status: 403,
    description: 'ATTENDANCE_NOT_TRACKED — enrolment/setup/kill-switch gate',
  })
  @ApiResponse({
    status: 422,
    description:
      'ATTENDANCE_TOO_FAR (distanceM/radiusM), ATTENDANCE_LOW_ACCURACY, ATTENDANCE_MOCK_LOCATION, ATTENDANCE_STALE_FIX, or body validation',
  })
  @ApiResponse({
    status: 429,
    description: 'ATTENDANCE_RATE_LIMITED with a Retry-After header (AD-15)',
  })
  checkIn(
    @CurrentUser() user: RequestUser,
    @Headers('x-idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CheckInOutDto,
  ) {
    return this.checkInOutService.checkIn(
      user,
      dto,
      this.requireIdempotencyKey(idempotencyKey),
    );
  }

  @Post('check-out')
  @Roles(Role.TECHNICIAN)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'FR-8 check-out: same gates as check-in, updates the same day record; returns worked minutes and the early-checkout flag',
  })
  @ApiResponse({
    status: 201,
    description:
      '{ workDate, checkinAt, checkoutAt, workedMinutes, earlyCheckout, earlyCheckoutMinutes, dayContext }',
  })
  @ApiResponse({
    status: 409,
    description: 'ATTENDANCE_NOT_CHECKED_IN or ATTENDANCE_ALREADY_CHECKED_OUT',
  })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({
    status: 422,
    description: 'Same location catalogue as check-in, or body validation',
  })
  @ApiResponse({
    status: 429,
    description: 'ATTENDANCE_RATE_LIMITED with a Retry-After header (AD-15)',
  })
  checkOut(
    @CurrentUser() user: RequestUser,
    @Headers('x-idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CheckInOutDto,
  ) {
    return this.checkInOutService.checkOut(
      user,
      dto,
      this.requireIdempotencyKey(idempotencyKey),
    );
  }

  /** AD-6 gate: missing/malformed key is a 422 with no attempt row. */
  private requireIdempotencyKey(value: string | undefined): string {
    if (!value || !UUID_V4_PATTERN.test(value)) {
      throw new HttpException(
        {
          error_code: ErrorCode.VALIDATION_ERROR,
          message: 'X-Idempotency-Key header is required and must be a UUID v4',
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return value;
  }
}
