import {
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AnyMember } from '../common/decorators/any-member.decorator';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { InviteSmsResendService } from './invite-sms/invite-sms-resend.service';

/**
 * Resend of the invite SMS (spec CAP-2, story 21-2). Kept apart from
 * AuthController to stay under the file-size limit.
 *
 * `@AnyMember` rather than `@Can`: a `@Can` refusal would be a generic
 * FORBIDDEN, but the contract answers every non-admin with NOT_COMPANY_ADMIN.
 * The company-admin rule is enforced in InviteSmsResendService, which reads
 * the `invite_sms.resend` permission from permissions.ts.
 */
@ApiTags('Auth')
@Controller('auth')
export class InviteSmsController {
  constructor(private readonly resendService: InviteSmsResendService) {}

  @Post('invite/:membershipUserId/resend-sms')
  @AnyMember()
  @ApiBearerAuth()
  @HttpCode(HttpStatus.CREATED)
  // Optional X-Idempotency-Key (UUID v4). A repeat with the same key replays the
  // stored answer and sends nothing, so a double-tap cannot send twice. Best
  // effort: two requests that arrive at the same instant can both get through,
  // but the per-phone cap still holds, because the slot reservation is atomic.
  @UseInterceptors(IdempotencyInterceptor)
  @ApiHeader({
    name: 'X-Idempotency-Key',
    required: false,
    description: 'Optional UUID v4. Reuse it only for a retry of the same tap.',
  })
  @ApiOperation({
    summary: 'Send the invite SMS again (company admin only)',
    description:
      'Resends the invite text to a person who has not joined yet. At most 5 invite texts reach one phone number in any rolling 60 minutes, counting every invite and re-invite. A failed send does not count, but a timeout does, because the text may have arrived. Sending is off while the DLT template is pending, and then sms_status is not_configured.',
  })
  @ApiParam({
    name: 'membershipUserId',
    description:
      'The invited membership user ID, the same value as invite_id from POST /auth/invite',
  })
  @ApiResponse({
    status: 201,
    description:
      'Resend attempted. sms_status: sent, failed (not counted toward the cap, except a timeout) or not_configured (sending is off).',
    schema: { example: { sms_status: 'sent' } },
  })
  @ApiResponse({
    status: 403,
    description:
      'NOT_COMPANY_ADMIN — only a company admin of this company can resend. Employees, viewers and platform admins get this.',
  })
  @ApiResponse({
    status: 404,
    description:
      "INVITE_NOT_FOUND — no invited membership with this ID in the caller's company. Another company's membership gets the same answer.",
  })
  @ApiResponse({
    status: 409,
    description:
      'INVITE_NOT_PENDING — the membership is no longer invited (for example, the person has already joined). Nothing is sent.',
  })
  @ApiResponse({
    status: 429,
    description:
      'INVITE_SMS_LIMIT_REACHED — 5 invite texts have already reached this phone number in the last 60 minutes. Nothing is sent and no counter row is written.',
  })
  async resendInviteSms(
    @CurrentUser() user: RequestUser,
    @Param('membershipUserId', ParseUUIDPipe) membershipUserId: string,
  ) {
    return this.resendService.resend(user, membershipUserId);
  }
}
