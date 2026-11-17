import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
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
  PayrollPfConfigView,
  PayrollPfExclusionView,
  PutPayrollPfConfigDto,
  PutPayrollPfExclusionDto,
  TdsConfigView,
} from './dto/payroll-deductions.dto';
import { PayrollPfConfigService } from './pf-config.service';
import { PayrollPfExclusionService } from './pf-exclusion.service';
import { tdsConfigView } from './statutory';

/**
 * The statutory config surface (CAP-6): the tenant's PF-covered switch
 * (effective-dated), the per-employee PF exclusion (never-members only),
 * and a read-only view of the FY 2026-27 TDS constants the estimator uses.
 * Company-admin only (`payroll.config`). Plain table writes, no database
 * functions; one audit entry per mutation.
 */
@ApiTags('Payroll')
@ApiBearerAuth()
@Controller('payroll')
export class PayrollStatutoryController {
  constructor(
    private readonly pfConfigService: PayrollPfConfigService,
    private readonly pfExclusionService: PayrollPfExclusionService,
  ) {}

  @Get('pf-config')
  @Can('payroll.config')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "The company's dated PF-covered switch revisions, oldest first — an empty list means PF is off (employees carrying a UAN or PF account number are covered regardless)",
  })
  @ApiOkResponse({ type: [PayrollPfConfigView] })
  @ApiResponse({ status: 403, description: 'Not a company admin' })
  list(@CurrentUser() user: RequestUser) {
    return this.pfConfigService.list(user);
  }

  @Put('pf-config')
  @Can('payroll.config')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Save one dated PF-covered revision (create, or replace the same-date revision). The resolved month of a covered-on row is the first-coverage month; a re-run of an earlier month resolves that month as not covered.',
  })
  @ApiOkResponse({
    type: PayrollPfConfigView,
    description: 'The saved revision',
  })
  @ApiResponse({ status: 422, description: 'An invented date' })
  @ApiResponse({ status: 403, description: 'Not a company admin' })
  save(@CurrentUser() user: RequestUser, @Body() dto: PutPayrollPfConfigDto) {
    return this.pfConfigService.save(user, dto);
  }

  @Get('employees/:userId/pf-exclusion')
  @Can('payroll.config')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Whether an employee is excluded from PF (false when no row exists — enrollment is the default; an employee with a UAN or PF account number can never be excluded)',
  })
  @ApiOkResponse({ type: PayrollPfExclusionView })
  @ApiResponse({
    status: 404,
    description: 'No member with that id in the company',
  })
  @ApiResponse({ status: 403, description: 'Not a company admin' })
  readExclusion(
    @CurrentUser() user: RequestUser,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.pfExclusionService.read(user, userId);
  }

  @Put('employees/:userId/pf-exclusion')
  @Can('payroll.config')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Exclude a never-member from PF (EPFO-flux warning: the exclusion reading is administrative flux — enrollment is the default). Refused for anyone carrying a UAN or PF account number.',
  })
  @ApiOkResponse({ type: PayrollPfExclusionView })
  @ApiResponse({
    status: 422,
    description:
      'The employee carries a UAN or PF account number — ever-members are covered at any wage',
  })
  @ApiResponse({
    status: 404,
    description: 'No member with that id in the company',
  })
  @ApiResponse({ status: 403, description: 'Not a company admin' })
  saveExclusion(
    @CurrentUser() user: RequestUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: PutPayrollPfExclusionDto,
  ) {
    return this.pfExclusionService.save(user, userId, dto);
  }

  @Get('tds-config')
  @Can('payroll.config')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'The FY 2026-27 statutory TDS constants (new-regime slabs, ₹75,000 standard deduction, the resident-only s.157 rebate, 4% cess) — read-only; the estimator uses exactly these',
  })
  @ApiOkResponse({ type: TdsConfigView })
  @ApiResponse({ status: 403, description: 'Not a company admin' })
  tdsConfig() {
    return tdsConfigView();
  }
}
