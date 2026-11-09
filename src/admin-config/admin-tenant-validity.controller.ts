import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Put,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Can } from '../common/decorators/can.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import {
  AdminTenantValidityService,
  TenantValidityResult,
} from './admin-tenant-validity.service';
import { TenantValidityDto } from './dto/tenant-validity.dto';

@ApiTags('Admin')
@ApiBearerAuth()
@Controller('admin/tenants')
export class AdminTenantValidityController {
  constructor(private readonly validityService: AdminTenantValidityService) {}

  @Put(':tenantId/validity')
  @Can('tenant.validity.manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Set when a company subscription ends (super admin only). Manual extension.',
  })
  @ApiResponse({ status: 200, description: '{ tenantId, validUntil }' })
  @ApiResponse({ status: 403, description: 'Not a super admin' })
  @ApiResponse({ status: 404, description: 'No such company' })
  @ApiResponse({
    status: 422,
    description: 'validUntil missing or not an ISO-8601 instant',
  })
  setValidity(
    @CurrentUser() user: RequestUser,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body() dto: TenantValidityDto,
  ): Promise<TenantValidityResult> {
    return this.validityService.setValidity(
      user.userId,
      tenantId,
      dto.validUntil,
    );
  }
}
