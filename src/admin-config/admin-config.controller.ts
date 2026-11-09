import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
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
  AdminConfigService,
  AppRoadblocksConfigView,
} from './admin-config.service';
import { AppRoadblocksConfigDto } from './dto/app-roadblocks-config.dto';

/**
 * Super-admin (platform admin) editor for the force-update rules. Writes go
 * through here, never from the browser. Anyone else gets 403.
 */
@ApiTags('Admin')
@ApiBearerAuth()
@Controller('admin/config')
export class AdminConfigController {
  constructor(private readonly adminConfigService: AdminConfigService) {}

  @Get('app-roadblocks')
  @Can('app_config.manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Read the force-update rules and support contact (super admin only)',
  })
  @ApiResponse({ status: 200, description: '{ android, ios, support }' })
  @ApiResponse({ status: 403, description: 'Not a super admin' })
  getAppRoadblocks(): Promise<AppRoadblocksConfigView> {
    return this.adminConfigService.getAppRoadblocks();
  }

  @Put('app-roadblocks')
  @Can('app_config.manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Replace the force-update rules and support contact, per platform (super admin only). Installed apps pick the change up on next launch or foreground.',
  })
  @ApiResponse({
    status: 200,
    description: 'The saved values (same shape as GET)',
  })
  @ApiResponse({ status: 403, description: 'Not a super admin' })
  @ApiResponse({ status: 422, description: 'Validation error' })
  saveAppRoadblocks(
    @CurrentUser() user: RequestUser,
    @Body() dto: AppRoadblocksConfigDto,
  ): Promise<AppRoadblocksConfigView> {
    return this.adminConfigService.saveAppRoadblocks(user.userId, dto);
  }
}
