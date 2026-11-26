import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { HttpException } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ErrorCode } from '../common/enums/error-code.enum';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { LeaveService } from './leave.service';
import { LeaveReadService } from './leave-read.service';
import { LeaveTypesService } from './leave-types.service';
import { LeaveBalanceService } from './leave-balance.service';
import {
  ApproveLeaveDto,
  ListLeaveQueryDto,
  OnBehalfLeaveDto,
  OnBehalfPreviewQueryDto,
  RejectLeaveDto,
  RevokeLeaveDto,
} from './dto/leave.dto';
import { SetLeaveRequestTypeDto } from './dto/leave-type.dto';
import {
  CreditLeaveDto,
  CreditView,
  LeaveBalanceView,
} from './dto/leave-balance.dto';
import { Can } from '../common/decorators/can.decorator';

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
export class LeaveController {
  constructor(
    private readonly leaveService: LeaveService,
    private readonly leaveReadService: LeaveReadService,
    private readonly leaveTypesService: LeaveTypesService,
    private readonly leaveBalanceService: LeaveBalanceService,
  ) {}

  @Get(':employeeId/balances')
  @Can('leave.read_all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'One employee\u2019s derived leave balances for the current April-March FY — credits + accrued + carry-forward - consumed per accrual-bearing type',
  })
  @ApiOkResponse({
    type: [LeaveBalanceView],
    description:
      'One row per accrual-bearing type (disabled ones included — their consumed days still count); Comp-Off never appears (no balance)',
  })
  @ApiResponse({
    status: 404,
    description: 'The employee is not in this company',
  })
  employeeBalances(
    @CurrentUser() user: RequestUser,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
  ) {
    return this.leaveBalanceService.readEmployeeBalances(user, employeeId);
  }

  @Post('credits')
  @Can('leave.types')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Add one manual balance credit (or a negative correction) — per employee, per type, per FY; corrections are offsetting rows, never edits',
  })
  @ApiCreatedResponse({
    type: CreditView,
    description: 'The stored credit (source manual)',
  })
  @ApiResponse({
    status: 422,
    description:
      'days 0 / over 366 in magnitude / over 2 decimals, a malformed year, or a credit target with no accrual balance (Comp-Off)',
  })
  @ApiResponse({
    status: 404,
    description: 'The employee or the leave type is not in this company',
  })
  credit(@CurrentUser() user: RequestUser, @Body() dto: CreditLeaveDto) {
    return this.leaveBalanceService.applyCredit(user, dto);
  }

  @Get()
  @Can('leave.read_all', 'leave.read_team')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'FR-17: leave requests — the whole company for an admin, the caller\u2019s own subtree for a manager (filters: status — pending is the queue — employeeId, and the 27-1 from/to overlap window), derived status per request',
  })
  @ApiResponse({
    status: 403,
    description: 'Not an admin, and the caller has no reports',
  })
  @ApiResponse({
    status: 404,
    description: 'employeeId belongs to another branch',
  })
  @ApiResponse({
    status: 200,
    description: 'PaginatedResponse<request view + employeeName>, newest first',
  })
  @ApiResponse({
    status: 422,
    description: 'from or to is not a YYYY-MM-DD date, or from > to',
  })
  list(@CurrentUser() user: RequestUser, @Query() query: ListLeaveQueryDto) {
    return this.leaveReadService.listForOwner(user, query);
  }

  @Get('summary')
  @Can('leave.read_all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'The console\u2019s leave facts in one read — the calendar rail\u2019s team-size fact and the requests tab\u2019s per-status pill counts',
  })
  @ApiOkResponse({
    description:
      '{ activeEmployees, counts } — the headcount the availability meter divides by, plus the whole tenant\u2019s request counts by derived status (the same CASE the list filters with)',
  })
  summary(@CurrentUser() user: RequestUser) {
    return this.leaveReadService.readSummary(user);
  }

  @Get(':id/preview')
  @Can('leave.read_all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'FR-14 preview: exactly which dates a revoke would change vs keep (split rule, Start-time cutoff)',
  })
  @ApiResponse({
    status: 200,
    description: '{ action, actionDates, keepDates, request }',
  })
  previewRevoke(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.leaveReadService.previewRevoke(user, id);
  }

  @Get(':id/coverage')
  @Can('leave.read_all', 'leave.read_team')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'The request\u2019s coverage check — who else is available while the requester is out',
  })
  @ApiOkResponse({
    description:
      '{ officeName, availableCount, onDutyName, anchorDate } — active colleagues at the requester\u2019s office (company-wide when they have none) holding no pending-or-approved day inside the request\u2019s span. anchorDate is the span\u2019s first day — the date-anchored reads answer the office as of that day, not today (the planned-transfer story). A single-day span also drops colleagues on a weekly off or holiday that day, so the count reads "actually working that day"; multi-day spans read plain leave-free. onDutyName names one deterministically — the first colleague with a real (non-null, non-empty) name, null when nobody is named',
  })
  @ApiResponse({
    status: 404,
    description:
      'The request is not in this company, or is outside the caller’s subtree',
  })
  readCoverage(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.leaveReadService.readCoverage(user, id);
  }

  @Post(':id/approve')
  @Can('leave.approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'FR-13 approve: every pending day becomes approved; the employee is notified; the optional note rides the approval audit event',
  })
  @ApiResponse({
    status: 200,
    description: 'The refreshed request view (status approved)',
  })
  @ApiResponse({
    status: 409,
    description: 'LEAVE_NOT_PENDING (own retry answers 200)',
  })
  approve(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveLeaveDto,
  ) {
    return this.leaveService.approve(user, id, dto.note ?? null);
  }

  @Post(':id/reject')
  @Can('leave.approve')
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
  @Can('leave.approve')
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

  @Patch(':requestId/type')
  @Can('leave.types')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Set (or clear — null — back to the untyped = paid default) a request's paid/unpaid type from this company's catalog",
  })
  @ApiResponse({
    status: 200,
    description:
      '{ requestId, employeeId, leaveTypeId, paid } — paid is the marking the payroll run acts on (untyped reads paid)',
  })
  @ApiResponse({
    status: 404,
    description: 'The request or the type is not in this company',
  })
  @ApiResponse({
    status: 409,
    description:
      'The chosen type was deleted while the typing was in flight — reload and retry',
  })
  @ApiResponse({ status: 403, description: 'Not a company admin' })
  setRequestType(
    @CurrentUser() user: RequestUser,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() dto: SetLeaveRequestTypeDto,
  ) {
    return this.leaveTypesService.setRequestType(user, requestId, dto);
  }

  @Get('on-behalf/preview')
  @Can('leave.create_on_behalf')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '23-14 on-behalf apply preview: the same validation the on-behalf POST runs (persist:false) for a proposed spend on one employee — the apply-on-behalf form catches a refusal (insufficient balance, locked month, overlap) at pick time instead of at submit',
  })
  @ApiResponse({
    status: 200,
    description:
      '{ ok, workingDays, totalDays, part, dates[] } — or { ok: false, errorCode, message } rendered inline by the app (previews never 404/422)',
  })
  previewApplyOnBehalf(
    @CurrentUser() user: RequestUser,
    @Query() query: OnBehalfPreviewQueryDto,
  ) {
    return this.leaveReadService.previewApplyOnBehalf(user, query);
  }

  @Post('on-behalf')
  @Can('leave.create_on_behalf')
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
          message:
            'This request has no valid request ID. Update the app and try again.',
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return value;
  }
}
