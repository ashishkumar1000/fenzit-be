import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
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
import { ChangeRoleDto } from './dto/change-role.dto';
import { AuditLogQueryDto } from './dto/audit-log-query.dto';
import { MembersService } from './members.service';

@ApiTags('Members')
@ApiBearerAuth()
@Controller()
export class MembersController {
  constructor(private readonly membersService: MembersService) {}

  @Get('members')
  @Can('member.read')
  @ApiOperation({ summary: 'List the people of the company' })
  list(@CurrentUser() user: RequestUser) {
    return this.membersService.list(user);
  }

  @Patch('members/:userId/role')
  @Can('member.change_role')
  @ApiOperation({ summary: "Change a member's role (never your own)" })
  @ApiResponse({
    status: 403,
    description: 'Changing your own role, or not an admin',
  })
  @ApiResponse({
    status: 404,
    description: 'The person is not a member of this company',
  })
  @ApiResponse({
    status: 409,
    description: 'LAST_ADMIN — the company would have no admin',
  })
  changeRole(
    @CurrentUser() user: RequestUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: ChangeRoleDto,
  ) {
    return this.membersService.changeRole(user, userId, dto.role);
  }

  @Delete('members/:userId')
  @Can('member.remove')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Remove a member (their jobs, attendance and leave records are kept)',
  })
  @ApiResponse({
    status: 409,
    description: 'LAST_ADMIN — the company would have no admin',
  })
  @ApiResponse({ status: 403, description: 'Removing yourself, or not an admin' })
  @ApiResponse({ status: 404, description: 'The person is not a member of this company' })
  async remove(
    @CurrentUser() user: RequestUser,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<void> {
    await this.membersService.remove(user, userId);
  }

  @Post('admin/users/:userId/disable')
  @Can('user.disable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Disable a user account (platform admin only)' })
  @ApiResponse({ status: 403, description: 'Not a platform admin, or disabling your own account' })
  @ApiResponse({ status: 404, description: 'No such user' })
  @ApiResponse({ status: 409, description: 'LAST_ADMIN — the company would have no admin' })
  disable(
    @CurrentUser() user: RequestUser,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.membersService.setDisabled(user, userId, true);
  }

  @Post('admin/users/:userId/enable')
  @Can('user.disable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Re-enable a user account (platform admin only)' })
  @ApiResponse({ status: 403, description: 'Not a platform admin' })
  @ApiResponse({ status: 404, description: 'No such user' })
  enable(
    @CurrentUser() user: RequestUser,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.membersService.setDisabled(user, userId, false);
  }

  @Get('audit-log')
  @Can('audit.read')
  @ApiOperation({
    summary:
      'Read who changed what. A company admin sees their own company; a platform admin sees the named company, or all.',
  })
  auditLog(@CurrentUser() user: RequestUser, @Query() query: AuditLogQueryDto) {
    return this.membersService.auditLog(
      user,
      query.limit,
      query.before,
      query.beforeId,
    );
  }
}
