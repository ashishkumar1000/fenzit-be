import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { HttpException } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Role } from '../common/enums/role.enum';
import { ErrorCode } from '../common/enums/error-code.enum';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { LeaveService } from './leave.service';
import { LeaveReadService } from './leave-read.service';
import {
  ApplyLeaveDto,
  ListLeaveQueryDto,
  PreviewApplyQueryDto,
  RejectLeaveDto,
  RevokeLeaveDto,
} from './dto/leave.dto';

/** AD-6: UUID v4, generated per user tap by the app (same gate as check-in). */
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The employee's leave routes (17-1..17-4). The employee id comes ONLY
 * from the JWT (`@CurrentUser`) — never from the client (NFR-1). Apply
 * requires the X-Idempotency-Key (AD-6); cancel is state-guarded, no key.
 */
@ApiTags('Attendance')
@ApiBearerAuth()
@Controller('attendance/me/leave')
export class MeLeaveController {
  constructor(
    private readonly leaveService: LeaveService,
    private readonly leaveReadService: LeaveReadService,
  ) {}

  @Get('preview')
  @Roles(Role.TECHNICIAN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'FR-12 preview: working-day count and validation outcome for a proposed range — the same validation path as POST (no write)',
  })
  @ApiResponse({
    status: 200,
    description:
      '{ ok, workingDays, totalDays, part, dates[] } — or { ok: false, errorCode, message } rendered inline by the app',
  })
  previewApply(
    @CurrentUser() user: RequestUser,
    @Query() query: PreviewApplyQueryDto,
  ) {
    return this.leaveReadService.previewApply(user, {
      startDate: query.startDate,
      endDate: query.endDate,
      part: query.part ?? 'full_day',
      reason: '',
    });
  }

  @Post()
  @Roles(Role.TECHNICIAN)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'FR-12 apply for leave: date range or single date, full or half day, required reason — lands Pending for the owner',
  })
  @ApiResponse({
    status: 201,
    description:
      'The created request view (derived status pending, per-day states, workingDays)',
  })
  @ApiResponse({
    status: 403,
    description: 'ATTENDANCE_NOT_TRACKED — no active/upcoming enrolment',
  })
  @ApiResponse({
    status: 422,
    description:
      'LEAVE_INVALID_RANGE / LEAVE_TOO_OLD / LEAVE_BEFORE_START_DATE / LEAVE_CHECKED_IN_CONFLICT / LEAVE_ALREADY_OFF, or body validation',
  })
  @ApiResponse({
    status: 409,
    description:
      'LEAVE_OVERLAP (pending/approved days in range) or DUPLICATE_RESOURCE (raced key)',
  })
  apply(
    @CurrentUser() user: RequestUser,
    @Headers('x-idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: ApplyLeaveDto,
  ) {
    return this.leaveService.applyForSelf(
      user,
      dto,
      this.requireIdempotencyKey(idempotencyKey),
    );
  }

  @Get()
  @Roles(Role.TECHNICIAN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'FR-17: this employee’s leave history — derived status, dates, working days, reason',
  })
  @ApiResponse({
    status: 200,
    description: 'PaginatedResponse<request view>, newest first',
  })
  list(@CurrentUser() user: RequestUser, @Query() query: ListLeaveQueryDto) {
    return this.leaveReadService.listMine(user, query);
  }

  @Get(':id/preview')
  @Roles(Role.TECHNICIAN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'FR-15 preview: exactly which dates a cancel would change vs keep (split rule, FR-15 cutoff)',
  })
  @ApiResponse({
    status: 200,
    description: '{ action, actionDates, keepDates, request }',
  })
  previewCancel(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.leaveReadService.previewCancel(user, id);
  }

  @Post(':id/cancel')
  @Roles(Role.TECHNICIAN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'FR-15 cancel: not-yet-started pending/approved dates — today only before the Office-Start cutoff; no reason required',
  })
  @ApiResponse({
    status: 200,
    description: 'The refreshed request view + cancelledDates',
  })
  @ApiResponse({ status: 404, description: 'LEAVE_REQUEST_NOT_FOUND' })
  @ApiResponse({
    status: 409,
    description:
      'LEAVE_NOT_CANCELLABLE (nothing actionable; own retry answers 200)',
  })
  cancel(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.leaveService.cancel(user, id);
  }

  /** AD-6 gate: missing/malformed key is a 422 with no row (16-1 pattern). */
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
