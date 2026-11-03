import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { AnyMember } from '../common/decorators/any-member.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { VerifyOtpDto } from '../auth/dto/verify-otp.dto';
import { AccountDeletionService } from './account-deletion.service';

@ApiTags('Account deletion')
@Controller('account-deletion')
export class AccountDeletionController {
  constructor(
    private readonly accountDeletionService: AccountDeletionService,
  ) {}

  @Post('requests/me')
  @AnyMember()
  @ApiBearerAuth()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Ask for the signed-in account and its personal data to be deleted (JWT)',
    description:
      'The signed-in identity replaces the OTP proof, so the app asks no code. ' +
      'Files the same reviewed request as the public flow, and answers the same ' +
      'whether or not a request is already open.',
  })
  @ApiResponse({ status: 202, description: 'Request received' })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 500, description: 'Could not save the request' })
  async requestForSignedIn(
    @CurrentUser() user: RequestUser,
  ): Promise<{ message: string }> {
    return {
      message: await this.accountDeletionService.requestForSignedIn(user),
    };
  }

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
