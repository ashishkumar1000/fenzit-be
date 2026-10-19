import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { CreateEarlyAccessDto } from './dto/create-early-access.dto';
import { EarlyAccessResponseDto } from './dto/early-access-response.dto';
import { EarlyAccessService } from './early-access.service';

const JOINED_MESSAGE = 'Thanks. We will email you when access opens.';

@ApiTags('Early access')
@Controller('early-access')
export class EarlyAccessController {
  constructor(private readonly earlyAccessService: EarlyAccessService) {}

  @Post()
  @Public()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Join the early access list (public)' })
  @ApiResponse({
    status: 202,
    description:
      'Accepted. The message is the same for a new or an existing email.',
    type: EarlyAccessResponseDto,
  })
  @ApiResponse({ status: 422, description: 'Invalid email or phone' })
  @ApiResponse({ status: 500, description: 'Could not save the sign-up' })
  async join(
    @Body() dto: CreateEarlyAccessDto,
  ): Promise<EarlyAccessResponseDto> {
    const reference = await this.earlyAccessService.join(dto);
    return { message: JOINED_MESSAGE, reference };
  }
}
