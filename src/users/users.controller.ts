import {
  Controller,
  Get,
  Patch,
  Post,
  Put,
  Body,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { UsersService } from './users.service';
import { AvatarService } from './avatar.service';
import { GetProfileQueryDto } from './dto/get-profile-query.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { AvatarUploadRequestDto } from './dto/avatar-upload-request.dto';
import { ConfirmAvatarDto } from './dto/confirm-avatar.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { AnyMember } from '../common/decorators/any-member.decorator';

@ApiTags('Users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly avatarService: AvatarService,
  ) {}

  @Get('me')
  @AnyMember()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Get the current user's profile — branches by role. Owner gets " +
      'company/tenant info, technician roster + skills, all customers, and ' +
      'all jobs + jobCounts (today/upcoming/overdue/completed/cancelled). ' +
      'Technician gets own skills, own jobs, and own jobCounts. Every job ' +
      'row embeds technician (id, name, phone, skills) and customer (id, ' +
      'name, phone, address, city) summaries. jobsScope=today narrows the ' +
      'jobs page to the current IST day window, sorted soonest-first.',
  })
  @ApiResponse({
    status: 200,
    description:
      'Role-specific profile payload. Includes subscription.validUntil (UTC ISO-8601 end of the company subscription, or null with no company).',
  })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 400, description: 'Malformed cursor' })
  @ApiResponse({ status: 422, description: 'Invalid jobsScope value' })
  getMyProfile(
    @CurrentUser() user: RequestUser,
    @Query() query: GetProfileQueryDto,
  ) {
    return this.usersService.getMyProfile(user, query);
  }

  @Get('me/access')
  @AnyMember()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Get the current user's access only: role, company id and platform-admin " +
      'flag. Use this to re-check access on every foreground; GET /users/me ' +
      'is the full profile and is heavier.',
  })
  @ApiResponse({
    status: 200,
    description: 'Role, company id and platform-admin flag',
  })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  getMyAccess(@CurrentUser() user: RequestUser) {
    return this.usersService.getMyAccess(user);
  }

  @Patch('me')
  @AnyMember()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Update the current user's own display name",
  })
  @ApiResponse({
    status: 200,
    description: 'Updated profile payload (same shape as GET /users/me)',
  })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 422, description: 'Validation error' })
  updateMyProfile(
    @CurrentUser() user: RequestUser,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.usersService.updateMyProfile(user, dto);
  }

  @Post('me/avatar/upload-url')
  @AnyMember()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Step 1 of changing your photo: get a short-lived link to upload it ' +
      'to. JPEG or PNG, 2 MB or smaller. Upload the file with a PUT to ' +
      '`uploadUrl` using the same Content-Type, then call PUT /users/me/avatar.',
  })
  @ApiResponse({
    status: 200,
    description: '{ uploadUrl, key, expiresAt, maxBytes }',
  })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({
    status: 422,
    description: 'Unsupported type or size over 2 MB',
  })
  requestAvatarUpload(
    @CurrentUser() user: RequestUser,
    @Body() dto: AvatarUploadRequestDto,
  ) {
    return this.avatarService.requestUpload(user, dto);
  }

  @Put('me/avatar')
  @AnyMember()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Step 2 of changing your photo: confirm the upload finished. The photo ' +
      'is checked (type and size) before it is saved. Returns the profile.',
  })
  @ApiResponse({
    status: 200,
    description: 'Profile payload (same shape as GET /users/me)',
  })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({
    status: 403,
    description: 'The key belongs to another person',
  })
  @ApiResponse({ status: 404, description: 'No upload found at that key' })
  @ApiResponse({ status: 422, description: 'Wrong type or over 2 MB' })
  async confirmAvatar(
    @CurrentUser() user: RequestUser,
    @Body() dto: ConfirmAvatarDto,
  ) {
    await this.avatarService.confirmUpload(user, dto.key);
    return this.usersService.getMyProfile(user, {});
  }
}
