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
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Can } from '../common/decorators/can.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { AccountDeletionAdminService } from './account-deletion-admin.service';
import {
  ListAccountDeletionRequestsQueryDto,
  ResolveAccountDeletionRequestDto,
} from './dto/account-deletion-admin.dto';

/** Account deletion request queue for Fenzit platform admins only (user.manage). */
@ApiTags('Admin')
@ApiBearerAuth()
@Controller('admin/account-deletion-requests')
export class AccountDeletionAdminController {
  constructor(
    private readonly accountDeletionAdminService: AccountDeletionAdminService,
  ) {}

  @Get()
  @Can('user.manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'List account deletion requests (platform admin only; open by default)',
  })
  @ApiResponse({ status: 403, description: 'Not a platform admin' })
  list(@Query() query: ListAccountDeletionRequestsQueryDto) {
    return this.accountDeletionAdminService.list(query.status);
  }

  @Post(':requestId/resolve')
  @Can('user.manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Mark a deletion request completed or rejected (platform admin only)',
  })
  @ApiResponse({ status: 404, description: 'Request not found' })
  @ApiResponse({ status: 409, description: 'Request already resolved' })
  resolve(
    @CurrentUser() user: RequestUser,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() dto: ResolveAccountDeletionRequestDto,
  ) {
    return this.accountDeletionAdminService.resolve(
      user,
      requestId,
      dto.action,
    );
  }
}
