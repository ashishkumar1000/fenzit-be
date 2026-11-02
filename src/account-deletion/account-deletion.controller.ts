import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { VerifyOtpDto } from '../auth/dto/verify-otp.dto';
import { AccountDeletionService } from './account-deletion.service';

@ApiTags('Account deletion')
@Controller('account-deletion')
export class AccountDeletionController {
  constructor(
    private readonly accountDeletionService: AccountDeletionService,
  ) {}

  @Post('requests')
  @Public()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Ask for an account and its personal data to be deleted (public)',
    description:
      'Send a code with POST /auth/otp/send first, then send the session and code here. The answer is the same whether or not an account matches the number.',
  })
  @ApiResponse({ status: 202, description: 'Request received' })
  @ApiResponse({ status: 401, description: 'Invalid, expired, or locked code' })
  @ApiResponse({
    status: 422,
    description: 'Invalid session ID or code format',
  })
  @ApiResponse({ status: 500, description: 'Could not save the request' })
  async request(@Body() dto: VerifyOtpDto): Promise<{ message: string }> {
    return { message: await this.accountDeletionService.request(dto) };
  }
}
