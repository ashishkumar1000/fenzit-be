import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Can } from '../common/decorators/can.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { PayrollPayslipsService } from './payroll-payslips.service';

/**
 * The payslip snapshot surface (CAP-7, story 23-8). Admin routes sit under
 * `payroll.config`; the /me self-service routes sit under the new
 * `payroll.own` (EMPLOYEE only, outside ADMIN_PERMISSIONS) and answer only
 * for LOCKED months. The PDF request POSTs queue a `payslip` report request
 * each (payroll-side insert); both carry the house IdempotencyInterceptor.
 *
 * Route order matters: the /me routes are declared BEFORE the
 * :membershipId route — otherwise `me` would match the uuid parameter.
 */
@ApiTags('Payroll')
@ApiBearerAuth()
@Controller('payroll')
export class PayrollPayslipsController {
  constructor(private readonly payslipsService: PayrollPayslipsService) {}

  @Get('payslips')
  @Can('payroll.config')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "One month's payslip snapshots (slip-number order, any month state — pre-lock preview included), each with its PDF request state (status, and a fresh presigned URL when ready)",
  })
  @ApiResponse({
    status: 200,
    description: 'The month payslips (possibly empty)',
  })
  @ApiResponse({ status: 422, description: 'month must be YYYY-MM' })
  @ApiResponse({ status: 403, description: 'Not a company admin' })
  adminList(@CurrentUser() user: RequestUser, @Query('month') month: string) {
    return this.payslipsService.adminList(user, month);
  }

  @Get('payslips/me')
  @Can('payroll.own')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Your payslip history — locked months only, newest first, each with its PDF request state (status, and a fresh presigned URL when ready)',
  })
  @ApiResponse({ status: 200, description: 'Your payslips (possibly empty)' })
  ownHistory(@CurrentUser() user: RequestUser) {
    return this.payslipsService.ownHistory(user);
  }

  @Get('payslips/me/:month')
  @Can('payroll.own')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'One of your payslips — 404 in plain English when the month was never run, when it is not locked yet, or when you were not in that month',
  })
  @ApiResponse({ status: 200, description: 'Your payslip for the month' })
  @ApiResponse({
    status: 404,
    description: 'Not run yet / not locked yet / none for you',
  })
  @ApiResponse({ status: 422, description: 'month must be YYYY-MM' })
  ownPayslip(@CurrentUser() user: RequestUser, @Param('month') month: string) {
    return this.payslipsService.ownPayslip(user, month);
  }

  @Post('payslips/me/:month/pdf')
  @Can('payroll.own')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(IdempotencyInterceptor)
  @ApiOperation({
    summary:
      'Request the PDF of one of your payslips (the month must be locked). Poll GET /payroll/payslips/me/:month — the pdf field carries the status and, when ready, a fresh download URL.',
  })
  @ApiResponse({
    status: 201,
    description:
      'PDF request queued (an already in-flight request for the same payslip is returned as-is)',
  })
  @ApiResponse({
    status: 404,
    description: 'Not run yet / not locked yet / none for you',
  })
  @ApiResponse({ status: 422, description: 'month must be YYYY-MM' })
  @ApiResponse({
    status: 429,
    description: 'Too many reports in progress for the company (max 3)',
  })
  requestPdfOwn(
    @CurrentUser() user: RequestUser,
    @Param('month') month: string,
  ) {
    return this.payslipsService.requestPdfOwn(user, month);
  }

  @Post('payslips/:membershipId/:month/pdf')
  @Can('payroll.config')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(IdempotencyInterceptor)
  @ApiOperation({
    summary:
      "Request the PDF of one employee's payslip for a month (any month state — a live payslip row is the only gate). Poll GET /payroll/payslips?month= — the pdf field carries the status and, when ready, a fresh download URL.",
  })
  @ApiResponse({
    status: 201,
    description:
      'PDF request queued (an already in-flight request for the same payslip is returned as-is)',
  })
  @ApiResponse({
    status: 404,
    description: 'No payslip exists for that employee in the month',
  })
  @ApiResponse({
    status: 422,
    description:
      'month must be YYYY-MM / membershipId must be a valid employee id',
  })
  @ApiResponse({ status: 403, description: 'Not a company admin' })
  @ApiResponse({
    status: 429,
    description: 'Too many reports in progress for the company (max 3)',
  })
  requestPdfFor(
    @CurrentUser() user: RequestUser,
    @Param('membershipId') membershipId: string,
    @Param('month') month: string,
  ) {
    return this.payslipsService.requestPdfFor(user, membershipId, month);
  }
}
