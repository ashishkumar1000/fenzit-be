import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Can } from '../common/decorators/can.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import {
  PayrollRunOverrideView,
  PayrollRunView,
  PostPayrollRunDto,
  PutPayrollRunOverrideDto,
} from './dto/payroll-run.dto';
import { PayrollRunService } from './payroll-run.service';
import { PayrollRunOverrideService } from './payroll-run-override.service';

/**
 * The run lifecycle (CAP-3) and the per-employee run override (CAP-6).
 * Company-admin only (`payroll.config`). The run is async — POST answers
 * once the run is queued and the status polls.
 */
@ApiTags('Payroll')
@ApiBearerAuth()
@Controller('payroll')
export class PayrollRunController {
  constructor(
    private readonly runService: PayrollRunService,
    private readonly overrideService: PayrollRunOverrideService,
  ) {}

  @Post('runs')
  @Can('payroll.config')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      "Enqueue the monthly run for one month — accepted only on/after the company's first payroll month, not in the future, and on/after the month's cut-off day (tenant time). Async: poll GET /payroll/runs/:id.",
  })
  @ApiCreatedResponse({
    type: PayrollRunView,
    description:
      'The run was queued (an already-queued or running run for the month is returned as-is)',
  })
  @ApiResponse({
    status: 422,
    description:
      'The plain-English refusal: before the bound, a future month, or before the cut-off day',
  })
  @ApiResponse({ status: 403, description: 'Not a company admin' })
  enqueue(@CurrentUser() user: RequestUser, @Body() dto: PostPayrollRunDto) {
    return this.runService.enqueue(user, dto);
  }

  @Get('runs')
  @Can('payroll.config')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'The recent runs, newest first (up to 50).' })
  @ApiOkResponse({ type: [PayrollRunView] })
  @ApiResponse({ status: 403, description: 'Not a company admin' })
  list(@CurrentUser() user: RequestUser) {
    return this.runService.list(user);
  }

  @Get('runs/:runId')
  @Can('payroll.config')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'One run: the polled status (queued → running → completed | failed, failed terminal and retryable) and, once completed, the run summary (skips, warnings, recoveries).',
  })
  @ApiOkResponse({ type: PayrollRunView })
  @ApiResponse({
    status: 404,
    description: 'No run with that id in the company',
  })
  @ApiResponse({ status: 403, description: 'Not a company admin' })
  status(
    @CurrentUser() user: RequestUser,
    @Param('runId', ParseUUIDPipe) runId: string,
  ) {
    return this.runService.status(user, runId);
  }

  @Put('employees/:userId/run-override')
  @Can('payroll.config')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Replace one computed amount (PF employee share or TDS) for one employee and one salary period, behind the employer-liability acknowledgment. Survives unlocked re-runs; immutable after lock (the lock story).',
  })
  @ApiOkResponse({ type: PayrollRunOverrideView })
  @ApiResponse({
    status: 422,
    description:
      'A missing acknowledgment, a bad field, or an invented month/amount',
  })
  @ApiResponse({
    status: 404,
    description: 'No member with that id in the company',
  })
  @ApiResponse({ status: 403, description: 'Not a company admin' })
  saveOverride(
    @CurrentUser() user: RequestUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: PutPayrollRunOverrideDto,
  ) {
    return this.overrideService.save(user, userId, dto);
  }
}
