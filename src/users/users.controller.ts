import {
  Controller,
  Get,
  Patch,
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
import { GetProfileQueryDto } from './dto/get-profile-query.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Role } from '../common/enums/role.enum';
import type { RequestUser } from '../common/interfaces/request-user.interface';

@ApiTags('Users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  @Roles(Role.OWNER, Role.TECHNICIAN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Get the current user's profile — branches by role. Owner gets " +
      'company/tenant info, technician roster + skills, all customers, and ' +
      'all jobs + jobCounts (today/upcoming/overdue/completed/cancelled). ' +
      'Technician gets own skills, own jobs, and own jobCounts.',
  })
  @ApiResponse({ status: 200, description: 'Role-specific profile payload' })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 400, description: 'Malformed cursor' })
  getMyProfile(
    @CurrentUser() user: RequestUser,
    @Query() query: GetProfileQueryDto,
  ) {
    return this.usersService.getMyProfile(user, query);
  }

  @Patch('me')
  @Roles(Role.OWNER, Role.TECHNICIAN)
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
}
