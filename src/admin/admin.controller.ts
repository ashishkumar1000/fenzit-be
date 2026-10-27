import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Can } from '../common/decorators/can.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { AdminService } from './admin.service';
import { LookupUserQueryDto } from './dto/lookup-user-query.dto';
import { PlatformAdminFlagDto } from './dto/platform-admin-flag.dto';

/**
 * Staff-only web-admin endpoints (user.manage). The lookup is read-only;
 * the flag write is auto-audited by the platform-audit interceptor, which
 * is why the target path parameter must stay literally `:userId` and a
 * UUID. Destructive work (remove/purge) deliberately has no endpoint here —
 * it stays super-CLI only.
 */
@ApiTags('Admin')
@ApiBearerAuth()
@Controller()
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('admin/users/lookup')
  @Can('user.manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Everything the system knows about one person, matched by exact phone (platform admin only)',
  })
  @ApiQuery({
    name: 'phone',
    description: '10-digit Indian mobile number, with optional 91 prefix or +91',
    example: '98765 43210',
  })
  @ApiResponse({ status: 404, description: 'No person with this number' })
  @ApiResponse({ status: 400, description: 'Not an Indian mobile number' })
  lookup(@Query() query: LookupUserQueryDto) {
    return this.adminService.lookup(query.phone);
  }

  @Post('admin/users/:userId/platform-admin')
  @Can('user.manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Promote or demote the platform_admin staff flag (platform admin only)',
  })
  @ApiParam({ name: 'userId', format: 'uuid' })
  @ApiResponse({
    status: 409,
    description: 'PLATFORM_ADMIN_SELF — you cannot change your own flag',
  })
  @ApiResponse({ status: 404, description: 'No such user' })
  setPlatformAdmin(
    @CurrentUser() user: RequestUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: PlatformAdminFlagDto,
  ) {
    return this.adminService.setPlatformAdmin(user, userId, dto.value);
  }
}
