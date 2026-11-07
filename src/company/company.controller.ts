import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CompanyService } from './company.service';
import { UpdateCompanyDto } from './dto/update-company.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Can } from '../common/decorators/can.decorator';
import { AnyMember } from '../common/decorators/any-member.decorator';
import type { RequestUser } from '../common/interfaces/request-user.interface';

@ApiTags('Company')
@ApiBearerAuth()
@Controller('company')
export class CompanyController {
  constructor(private readonly companyService: CompanyService) {}

  @Patch()
  @Can('company.manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Owner only: update the company's GST number and business types. " +
      'Absent fields are left as they are.',
  })
  @ApiResponse({ status: 200, description: 'Updated company details' })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 403, description: 'Not the company owner' })
  @ApiResponse({
    status: 422,
    description: 'Invalid GSTIN or unknown business type',
  })
  updateCompany(
    @CurrentUser() user: RequestUser,
    @Body() dto: UpdateCompanyDto,
  ) {
    return this.companyService.updateCompany(user, dto);
  }
}

@ApiTags('Company')
@ApiBearerAuth()
@Controller('business-types')
export class BusinessTypesController {
  constructor(private readonly companyService: CompanyService) {}

  @Get()
  @AnyMember()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'List the business types a company can pick' })
  @ApiResponse({
    status: 200,
    description: '{ businessTypes: [{ code, label }] }',
  })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  listBusinessTypes() {
    return this.companyService.listBusinessTypes();
  }
}
