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
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Can } from '../common/decorators/can.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { ChangeRoleDto } from './dto/change-role.dto';
import { EmploymentView } from './dto/employment-view.dto';
import { JobSettingsDto } from './dto/job-settings.dto';
import { MembersPageQueryDto } from './dto/members-page-query.dto';
import { SetMemberActiveDto } from './dto/set-member-active.dto';
import { UpdateEmploymentDto } from './dto/update-employment.dto';
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

  @Get('members/page')
  @Can('member.read')
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'pageSize', required: false, example: 10 })
  @ApiQuery({ name: 'search', required: false, example: 'amit' })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['all', 'active', 'invited', 'deactivated'],
  })
  @ApiQuery({
    name: 'role',
    required: false,
    enum: ['all', 'company_admin', 'employee', 'viewer'],
  })
  @ApiQuery({
    name: 'jobSetting',
    required: false,
    enum: ['all', 'off', 'create_only', 'approval'],
  })
  @ApiQuery({
    name: 'sort',
    required: false,
    enum: ['joined_new', 'joined_old', 'name_az', 'name_za', 'code_az', 'code_za'],
  })
  @ApiOperation({
    summary:
      'One page of the company people, filtered and sorted. Filtering and paging happen in the service (no RPC). `stats` counts the whole team regardless of the filters.',
  })
  listPaged(
    @CurrentUser() user: RequestUser,
    @Query() query: MembersPageQueryDto,
  ) {
    return this.membersService.listPaged(user, query);
  }

  @Get('members/:userId')
  @Can('member.read')
  @ApiOperation({
    summary:
      "One member of the company: identity, employee code, role, status, flags and skills. The statutory fields (PAN, DOB, bank) are only on the employment endpoint.",
  })
  @ApiOkResponse({
    description: 'The member as the list serves them (plus skills)',
  })
  @ApiResponse({
    status: 404,
    description: 'The person is not a member of this company',
  })
  getMember(
    @CurrentUser() user: RequestUser,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.membersService.getMember(user, userId);
  }

  @Patch('members/:userId/active')
  @Can('member.deactivate')
  @ApiOperation({
    summary:
      "Park or reinstate a member: false deactivates an active member (they keep every record but lose access), true reinstates a deactivated one",
  })
  @ApiResponse({
    status: 403,
    description: 'Deactivating yourself, or not a company admin of this company',
  })
  @ApiResponse({
    status: 404,
    description: 'The person is not a member of this company',
  })
  @ApiResponse({
    status: 409,
    description:
      'The member is not in a state this move allows, or the company would be left without an active admin',
  })
  setActive(
    @CurrentUser() user: RequestUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: SetMemberActiveDto,
  ) {
    return this.membersService.setActive(user, userId, dto.active);
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

  @Patch('members/:userId/job-settings')
  @Can('member.job_settings')
  @ApiOperation({
    summary:
      "Set an employee's job switches: may create jobs, and whether owner approval is needed",
  })
  @ApiResponse({
    status: 400,
    description: 'NOT_AN_EMPLOYEE — the person is not an employee',
  })
  @ApiResponse({
    status: 403,
    description: 'Not a company admin of this company',
  })
  @ApiResponse({
    status: 404,
    description: 'The person is not an active member of this company',
  })
  setJobSettings(
    @CurrentUser() user: RequestUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: JobSettingsDto,
  ) {
    return this.membersService.setJobSettings(user, userId, {
      canCreateJobs: dto.canCreateJobs,
      jobApprovalRequired: dto.jobApprovalRequired,
    });
  }

  @Get('members/:userId/employment')
  @Can('member.employment')
  @ApiOperation({
    summary:
      "Read one member's employment record: join/exit dates, PAN, DOB, Form V names, PF/UAN, bank, designation, department and the employee code",
  })
  @ApiOkResponse({
    type: EmploymentView,
    description: 'The employment record as stored',
  })
  @ApiResponse({
    status: 400,
    description: 'userId is not a UUID',
  })
  @ApiResponse({
    status: 403,
    description: 'Not a company admin of this company',
  })
  @ApiResponse({
    status: 404,
    description: 'The person is not a member of this company',
  })
  getEmployment(
    @CurrentUser() user: RequestUser,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<EmploymentView> {
    return this.membersService.getEmployment(user, userId);
  }

  @Patch('members/:userId/employment')
  @Can('member.employment')
  @ApiOperation({
    summary:
      "Save one member's employment record. A key present in the body sets it, an absent key is left alone, null clears it. The employee code cannot be cleared.",
  })
  @ApiOkResponse({
    type: EmploymentView,
    description: 'The employment record as now stored',
  })
  @ApiResponse({
    status: 400,
    description: 'userId is not a UUID',
  })
  @ApiResponse({
    status: 403,
    description: 'Not a company admin of this company',
  })
  @ApiResponse({
    status: 404,
    description: 'The person is not a member of this company',
  })
  @ApiResponse({
    status: 409,
    description:
      'The employee code is already used by another member of this company, or the record changed since it was read',
  })
  @ApiResponse({
    status: 422,
    description:
      'Bad employment data: invented dates, an exit before or without a join, a cleared employee code, a malformed PAN or IFSC',
  })
  updateEmployment(
    @CurrentUser() user: RequestUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: UpdateEmploymentDto,
  ): Promise<EmploymentView> {
    return this.membersService.updateEmployment(user, userId, dto);
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
  @ApiResponse({
    status: 403,
    description: 'Removing yourself, or not an admin',
  })
  @ApiResponse({
    status: 404,
    description: 'The person is not a member of this company',
  })
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
  @ApiResponse({
    status: 403,
    description: 'Not a platform admin, or disabling your own account',
  })
  @ApiResponse({ status: 404, description: 'No such user' })
  @ApiResponse({
    status: 409,
    description: 'LAST_ADMIN — the company would have no admin',
  })
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
