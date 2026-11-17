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
  PutSalaryStructureDto,
  SalaryStructureView,
} from './dto/salary-structures.dto';
import { SalaryStructuresService } from './salary-structures.service';

/**
 * Per-employee effective-dated salary structures (CAP-2), on the member
 * surface next to the employment record (the 23-1 precedent). Company-admin
 * only (`payroll.config`). The save validates the whole structure against
 * its own lines — cycles, zero-operand division and negatives are refused
 * with the reason spelled out; the month-start rule means a mid-month-dated
 * revision is first used by the next month's run.
 */
@ApiTags('Payroll')
@ApiBearerAuth()
@Controller('members/:userId/salary-structures')
export class SalaryStructuresController {
  constructor(
    private readonly salaryStructuresService: SalaryStructuresService,
  ) {}

  @Get()
  @Can('payroll.config')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "The employee's dated salary-structure revisions, oldest first; component names are resolved as of this read (renames reach the next read and the next run)",
  })
  @ApiOkResponse({
    type: [SalaryStructureView],
    description: 'Every dated revision (possibly empty)',
  })
  @ApiResponse({
    status: 404,
    description: 'The person is not a member of this company',
  })
  @ApiResponse({ status: 403, description: 'Not a company admin' })
  list(
    @CurrentUser() user: RequestUser,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.salaryStructuresService.list(user, userId);
  }

  @Put()
  @Can('payroll.config')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Save one dated revision (create, or replace the same-date revision). The whole structure is validated at save: every referenced component must have a line, formulas may chain but must not cycle, must not divide by a zero amount and must not compute a negative, and the company's basic component must be included.",
  })
  @ApiOkResponse({
    type: SalaryStructureView,
    description: 'The saved revision, with computed amounts per line',
  })
  @ApiResponse({
    status: 404,
    description: 'The person is not a member of this company',
  })
  @ApiResponse({
    status: 422,
    description:
      'A validation failure (no basic, missing operand, cycle, zero-operand division, negative amount, bad date) — the message says which and why',
  })
  @ApiResponse({ status: 403, description: 'Not a company admin' })
  save(
    @CurrentUser() user: RequestUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: PutSalaryStructureDto,
  ) {
    return this.salaryStructuresService.save(user, userId, dto);
  }
}
