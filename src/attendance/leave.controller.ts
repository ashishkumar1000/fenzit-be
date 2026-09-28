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
  ListLeaveQueryDto,
  OnBehalfLeaveDto,
  RejectLeaveDto,
  RevokeLeaveDto,
} from './dto/leave.dto';

/** AD-6: UUID v4, generated per user tap by the app. */
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The owner's leave routes (17-2..17-4). Approve/reject/revoke are
 * state-guarded (AD-6: own retry answers 200, a conflicting state 409);
 * on-behalf apply requires the X-Idempotency-Key. Cross-tenant ids 404 —
 * no existence leak.
 */
@ApiTags('Attendance')
@ApiBearerAuth()
@Controller('attendance/leave')
@Roles(Role.OWNER)
export class LeaveController {
  constructor(
    private readonly leaveService: LeaveService,
    private readonly leaveReadService: LeaveReadService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'FR-17: all leave requests (filters: status — pending is the queue — and employeeId), derived status per request',
  })
  @ApiResponse({
    status: 200,
    description: 'PaginatedResponse<request view + employeeName>, newest first',
  })
  list(@CurrentUser() user: RequestUser, @Query() query: ListLeaveQueryDto) {
    return this.leaveReadService.listForOwner(user, query);
  }

  @Get(':id/preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'FR-14 preview: exactly which dates a revoke would change vs keep (split rule, Start-time cutoff)',
  })
  @ApiResponse({
    status: 200,
    description: '{ action, actionDates, keepDates, request }',
  })
  previewRevoke(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.leaveReadService.previewRevoke(user, id);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'FR-13 approve: every pending day becomes approved; the employee is notified',
  })
  @ApiResponse({
    status: 200,
    description: 'The refreshed request view (status approved)',
  })
  @ApiResponse({
    status: 409,
    description: 'LEAVE_NOT_PENDING (own retry answers 200)',
  })
  approve(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.leaveService.approve(user, id);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'FR-13 reject: optional reason; empty is valid' })
  @ApiResponse({
    status: 200,
    description: 'The refreshed request view (status rejected)',
  })
  @ApiResponse({
    status: 409,
    description: 'LEAVE_NOT_PENDING (own retry answers 200)',
  })
  reject(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectLeaveDto,
  ) {
    return this.leaveService.reject(user, id, dto.reason ?? null);
  }

  @Post(':id/revoke')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'FR-14 revoke: required reason; only not-yet-started approved dates — today only before the Office-Start cutoff (split)',
  })
  @ApiResponse({
    status: 200,
    description: 'The refreshed request view + revokedDates',
  })
  @ApiResponse({
    status: 422,
    description: 'Body validation (reason required)',
  })
  @ApiResponse({
    status: 409,
    description: 'LEAVE_NOT_REVOKABLE (own retry answers 200)',
  })
  revoke(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RevokeLeaveDto,
  ) {
    return this.leaveService.revoke(user, id, dto.reason);
  }

  @Post('on-behalf')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'FR-16 apply on behalf: same FR-12 validation, created Approved immediately — the employee is notified',
  })
  @ApiResponse({
    status: 201,
    description: 'The created request view (status approved)',
  })
  @ApiResponse({
    status: 404,
    description: 'ATTENDANCE_EMPLOYEE_NOT_FOUND — target outside this tenant',
  })
  @ApiResponse({
    status: 409,
    description: 'LEAVE_OVERLAP or DUPLICATE_RESOURCE (raced key)',
  })
  applyOnBehalf(
    @CurrentUser() user: RequestUser,
    @Headers('x-idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: OnBehalfLeaveDto,
  ) {
    return this.leaveService.applyOnBehalf(
      user,
      dto,
      this.requireIdempotencyKey(idempotencyKey),
    );
  }

  /** AD-6 gate: missing/malformed key is a 422 with no row. */
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
