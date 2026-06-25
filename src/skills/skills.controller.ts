import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { SkillsService } from './skills.service';
import { CreateSkillDto } from './dto/create-skill.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Role } from '../common/enums/role.enum';
import type { RequestUser } from '../common/interfaces/request-user.interface';

@ApiTags('Skills')
@ApiBearerAuth()
@Controller('skills')
export class SkillsController {
  constructor(private readonly skillsService: SkillsService) {}

  @Post()
  @Roles(Role.OWNER)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Create a skill for the owner's tenant" })
  @ApiResponse({ status: 201, description: 'Skill created' })
  @ApiResponse({ status: 400, description: 'Company not set up' })
  @ApiResponse({ status: 403, description: 'Forbidden — Technician JWT' })
  @ApiResponse({ status: 409, description: 'Duplicate skill name' })
  @ApiResponse({ status: 422, description: 'Validation error' })
  createSkill(@CurrentUser() user: RequestUser, @Body() dto: CreateSkillDto) {
    return this.skillsService.createSkill(user, dto);
  }

  @Get()
  @Roles(Role.OWNER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "List all skills for the owner's tenant" })
  @ApiResponse({ status: 200, description: 'Skills list' })
  @ApiResponse({ status: 403, description: 'Forbidden — Technician JWT' })
  listSkills(@CurrentUser() user: RequestUser) {
    return this.skillsService.listSkills(user);
  }

  @Delete(':id')
  @Roles(Role.OWNER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete a skill (cascades to assigned technicians)',
  })
  @ApiResponse({ status: 200, description: 'Skill deleted' })
  @ApiResponse({ status: 403, description: 'Forbidden — Technician JWT' })
  @ApiResponse({ status: 404, description: 'Skill not found' })
  deleteSkill(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.skillsService.deleteSkill(user, id);
  }
}
