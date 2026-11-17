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
  CreateSalaryComponentDto,
  SalaryComponentView,
  UpdateSalaryComponentDto,
} from './dto/payroll-components.dto';
import { PayrollComponentsService } from './payroll-components.service';

/**
 * The company salary component library (CAP-1). Company-admin only
 * (`payroll.config` sits outside ADMIN_PERMISSIONS — tenant payroll config
 * is not platform-staff business). Plain table writes, no database
 * functions; one audit entry per mutation.
 */
@ApiTags('Payroll')
@ApiBearerAuth()
@Controller('payroll/components')
export class PayrollComponentsController {
  constructor(
    private readonly payrollComponentsService: PayrollComponentsService,
  ) {}

  @Get()
  @Can('payroll.config')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'The company component library, name-ascending: each component carries the basic designation and its active flag',
  })
  @ApiOkResponse({
    type: [SalaryComponentView],
    description: 'Every component of this company (possibly empty)',
  })
  @ApiResponse({ status: 403, description: 'Not a company admin' })
  list(@CurrentUser() user: RequestUser) {
    return this.payrollComponentsService.list(user);
  }

  @Post()
  @Can('payroll.config')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Add a component. Pass isBasic to designate it THE basic component (the PF base) — refused while another component already holds the designation.',
  })
  @ApiCreatedResponse({
    type: SalaryComponentView,
    description: 'The created component',
  })
  @ApiResponse({
    status: 409,
    description:
      'The name is already used, or another component is already the basic one (named in the message)',
  })
  @ApiResponse({
    status: 422,
    description:
      'Bad name (empty or over 60 characters) or a non-boolean isBasic',
  })
  @ApiResponse({ status: 403, description: 'Not a company admin' })
  create(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateSalaryComponentDto,
  ) {
    return this.payrollComponentsService.create(user, dto);
  }

  @Patch(':id')
  @Can('payroll.config')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Rename a component and/or move the basic designation and/or deactivate it. Renames reach the next payroll run; deactivation is refused while any employee structure still references the component. No field can be cleared — null is refused.',
  })
  @ApiOkResponse({
    type: SalaryComponentView,
    description: 'The component as now stored',
  })
  @ApiResponse({
    status: 409,
    description:
      'Duplicate name, another component already basic, or structures still reference it (deactivation — the employees are listed)',
  })
  @ApiResponse({
    status: 422,
    description: 'name, isBasic or active sent as null (no clear verb)',
  })
  @ApiResponse({
    status: 404,
    description: 'The component is not in this company',
  })
  @ApiResponse({ status: 403, description: 'Not a company admin' })
  update(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSalaryComponentDto,
  ) {
    return this.payrollComponentsService.update(user, id, dto);
  }
}
