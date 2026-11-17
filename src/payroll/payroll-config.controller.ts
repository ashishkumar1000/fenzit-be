import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Can } from '../common/decorators/can.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import {
  PayrollCalendarView,
  PayrollMonthStatusView,
  PayrollStateRulesView,
  PutPayrollCalendarDto,
  PutPayrollStateRulesDto,
} from './dto/payroll-calendar.dto';
import { PayrollCalendarService } from './payroll-calendar.service';
import { PayrollMonthStatusService } from './payroll-month-status.service';
import { PayrollStateRulesService } from './payroll-state-rules.service';

/**
 * The payroll calendar and policy-config surface (CAP-4, CAP-8), plus the
 * month-status read the web UI and the run engine consume. Company-admin
 * only (`payroll.config`, outside ADMIN_PERMISSIONS). Plain table writes,
 * no database functions; one audit entry per mutation.
 */
@ApiTags('Payroll')
@ApiBearerAuth()
@Controller('payroll')
export class PayrollConfigController {
  constructor(
    private readonly calendarService: PayrollCalendarService,
    private readonly monthStatusService: PayrollMonthStatusService,
    private readonly stateRulesService: PayrollStateRulesService,
  ) {}

  @Get('calendar')
  @Can('payroll.config')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "The company's dated calendar revisions, oldest first — an empty list means the defaults govern (fixed-26 divisor, cut-off the 25th, pay date the 1st)",
  })
  @ApiOkResponse({
    type: [PayrollCalendarView],
    description: 'Every dated revision (possibly empty)',
  })
  @ApiResponse({ status: 403, description: 'Not a company admin' })
  list(@CurrentUser() user: RequestUser) {
    return this.calendarService.list(user);
  }

  @Put('calendar')
  @Can('payroll.config')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Save one dated calendar revision (create, or replace the same-date revision). Cut-off day must be 1-28 (February has fewer days than 29); pay date must be 1-7 (CoW s.17: wages payable before expiry of the 7th day). A mid-month-dated revision is first used by the NEXT month's run.",
  })
  @ApiOkResponse({
    type: PayrollCalendarView,
    description: 'The saved revision',
  })
  @ApiResponse({
    status: 422,
    description:
      'A validation failure — the February or CoW reason, a bad divisor, or an invented date',
  })
  @ApiResponse({ status: 403, description: 'Not a company admin' })
  saveCalendar(
    @CurrentUser() user: RequestUser,
    @Body() dto: PutPayrollCalendarDto,
  ) {
    return this.calendarService.save(user, dto);
  }

  @Get('months/:month')
  @Can('payroll.config')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'What one run month looks like for payroll: the month-start-resolved divisor/cut-off/pay date (defaults when no dated row governs), the lock flag (false until the lock story ships), and the first-payroll-month bound with a plain-English reason when the month is not runnable',
  })
  @ApiOkResponse({
    type: PayrollMonthStatusView,
    description: 'The month status',
  })
  @ApiResponse({ status: 400, description: 'month must be YYYY-MM' })
  @ApiResponse({ status: 403, description: 'Not a company admin' })
  monthStatus(@CurrentUser() user: RequestUser, @Param('month') month: string) {
    return this.monthStatusService.monthStatus(user, month);
  }

  @Get('state-rules')
  @Can('payroll.config')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Whether the company's state has notified its CoW state rules (false until saved)",
  })
  @ApiOkResponse({ type: PayrollStateRulesView })
  @ApiResponse({ status: 403, description: 'Not a company admin' })
  readStateRules(@CurrentUser() user: RequestUser) {
    return this.stateRulesService.read(user);
  }

  @Put('state-rules')
  @Can('payroll.config')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Set whether the company's state has notified its CoW state rules — the central Form V template ships either way",
  })
  @ApiOkResponse({ type: PayrollStateRulesView })
  @ApiResponse({ status: 403, description: 'Not a company admin' })
  saveStateRules(
    @CurrentUser() user: RequestUser,
    @Body() dto: PutPayrollStateRulesDto,
  ) {
    return this.stateRulesService.save(user, dto.notified);
  }
}
