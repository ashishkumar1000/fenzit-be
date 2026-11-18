import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
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
import {
  CreateOffCycleLineDto,
  OffCycleLineView,
  UpdateOffCycleLineDto,
} from './dto/payroll-offcycle.dto';
import { PayrollOffCycleService } from './payroll-offcycle.service';

/**
 * The off-cycle staging surface (CAP-10, story 23-9) — admin-only under
 * `payroll.config` (no employee surface; payslips carry the lines). POST
 * carries the house IdempotencyInterceptor; PATCH re-targets a staged line
 * (month, amount, label, tag, employee — the wrong-employee and orphan
 * remedies). A locked month refuses with 409 PAYROLL_MONTH_LOCKED.
 */
@ApiTags('Payroll')
@ApiBearerAuth()
@Controller('payroll')
export class PayrollOffCycleController {
  constructor(private readonly offCycleService: PayrollOffCycleService) {}

  @Post('off-cycle-lines')
  @Can('payroll.config')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(IdempotencyInterceptor)
  @ApiOperation({
    summary:
      'Stage a one-off line for one employee in an unlocked month — a positive earning (bonus/arrear/correction) or a negative recovery (needs the employer-liability acknowledgment)',
  })
  @ApiResponse({ status: 201, description: 'The staged line' })
  @ApiResponse({
    status: 422,
    description:
      'Zero amount, unacknowledged negative, future month, month before the first payroll month, no effective structure, or not an active employee',
  })
  @ApiResponse({
    status: 409,
    description: 'PAYROLL_MONTH_LOCKED or DUPLICATE_RESOURCE (same label)',
  })
  @ApiResponse({ status: 403, description: 'Not a company admin' })
  create(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateOffCycleLineDto,
  ): Promise<OffCycleLineView> {
    return this.offCycleService.create(user, dto);
  }

  @Get('off-cycle-lines')
  @Can('payroll.config')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "The company's off-cycle lines, newest first (optionally one month) — staged vs applied is visible here",
  })
  @ApiResponse({ status: 200, description: 'The lines (possibly empty)' })
  list(
    @CurrentUser() user: RequestUser,
    @Query('month') month?: string,
  ): Promise<OffCycleLineView[]> {
    return this.offCycleService.list(user, month);
  }

  @Patch('off-cycle-lines/:id')
  @Can('payroll.config')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Edit a STAGED line — re-target its month (the orphan remedy), fix the amount/label/tag, or move it to the right employee; applied lines are immutable',
  })
  @ApiResponse({ status: 200, description: 'The updated line' })
  @ApiResponse({
    status: 409,
    description:
      'The line is applied, the target month is locked, or the (employee, month, label) already exists',
  })
  update(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOffCycleLineDto,
  ): Promise<OffCycleLineView> {
    return this.offCycleService.update(user, id, dto);
  }
}
