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
  DeductionHeadView,
  PutDeductionHeadDto,
  PutHeadDeactivateDto,
} from './dto/payroll-deductions.dto';
import { DeductionHeadsService } from './deduction-heads.service';

/**
 * The company's deduction heads (CAP-6): flat or percentage heads with an
 * admin-picked basis, effective-dated per month-start. Company-admin only
 * (`payroll.config`). Plain table writes, no database functions; one audit
 * entry per mutation.
 */
@ApiTags('Payroll')
@ApiBearerAuth()
@Controller('payroll/deduction-heads')
export class PayrollHeadsController {
  constructor(private readonly headsService: DeductionHeadsService) {}

  @Get()
  @Can('payroll.config')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Every dated head revision, oldest date first within each name — the run engine applies each month's resolved heads (flat amounts; percentages of the earned basis)",
  })
  @ApiOkResponse({ type: [DeductionHeadView] })
  @ApiResponse({ status: 403, description: 'Not a company admin' })
  list(@CurrentUser() user: RequestUser) {
    return this.headsService.list(user);
  }

  @Post()
  @Can('payroll.config')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Save one dated head revision (create, or replace the same name+date revision). Percentage heads need a basis — the earned basic or the post-LOP gross they apply to; flat heads carry no basis. Percentage heads compute on the EARNED basis amount for the period.',
  })
  @ApiCreatedResponse({
    type: DeductionHeadView,
    description: 'The saved revision',
  })
  @ApiResponse({
    status: 422,
    description:
      'A validation failure — a percentage without a basis, a basis on a flat head, an out-of-range percentage, or an invented date',
  })
  @ApiResponse({ status: 403, description: 'Not a company admin' })
  save(@CurrentUser() user: RequestUser, @Body() dto: PutDeductionHeadDto) {
    return this.headsService.save(user, dto);
  }

  @Put(':headId/deactivate')
  @Can('payroll.config')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Retire a head — it drops out of every run after now. Deactivation has no undo; a new dated revision of the same name is the way back.',
  })
  @ApiOkResponse({ type: DeductionHeadView })
  @ApiResponse({
    status: 404,
    description: 'No active head with that id in the company',
  })
  @ApiResponse({ status: 403, description: 'Not a company admin' })
  deactivate(
    @CurrentUser() user: RequestUser,
    @Param('headId', ParseUUIDPipe) headId: string,
    @Body() dto: PutHeadDeactivateDto,
  ) {
    return this.headsService.deactivate(user, headId, dto.confirm);
  }
}
