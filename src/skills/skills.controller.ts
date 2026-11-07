import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Res,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { SkillsService } from './skills.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { AnyMember } from '../common/decorators/any-member.decorator';
import { Can } from '../common/decorators/can.decorator';
import { CreateSkillRequestDto } from './dto/create-skill-request.dto';

@ApiTags('Skills')
@ApiBearerAuth()
@Controller('skills')
export class SkillsController {
  constructor(private readonly skillsService: SkillsService) {}

  @Get()
  @AnyMember()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'List the global skills catalog (developer-seeded)',
  })
  @ApiResponse({
    status: 200,
    description:
      'Global skills catalog — { skills: [{ id, name, description, icon }] }',
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid JWT' })
  @ApiResponse({
    status: 403,
    description: 'Forbidden — role outside owner/technician',
  })
  async listGlobalSkills(@CurrentUser() user: RequestUser) {
    return { skills: await this.skillsService.listGlobalSkills(user) };
  }

  @Post('requests')
  @Can('member.invite')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Ask Fenzit to add a missing skill for this company',
    description:
      'Files a note for the Fenzit team. It does not add the skill. Asking again for the same name (ignoring case) is not an error.',
  })
  @ApiResponse({
    status: 201,
    description:
      'Request saved for the first time — { already_requested: false }',
  })
  @ApiResponse({
    status: 200,
    description:
      'The company already asked for this name — { already_requested: true }. Nothing new was saved.',
  })
  @ApiResponse({
    status: 400,
    description: 'Company setup is missing for this account',
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid JWT' })
  @ApiResponse({
    status: 403,
    description: 'Forbidden — needs permission to invite members',
  })
  @ApiResponse({
    status: 422,
    description: 'Skill name is not 2 to 60 characters',
  })
  @ApiResponse({ status: 500, description: 'Could not save the request' })
  async requestSkill(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateSkillRequestDto,
    @Res({ passthrough: true }) res: { status(code: number): unknown },
  ): Promise<{ already_requested: boolean }> {
    const result = await this.skillsService.createSkillRequest(user, dto.name);
    // A repeat creates nothing, so it answers 200 rather than 201.
    if (result.already_requested) res.status(HttpStatus.OK);
    return result;
  }
}
