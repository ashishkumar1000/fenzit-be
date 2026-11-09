import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { AnyMember } from '../common/decorators/any-member.decorator';
import { AllowExpiredSubscription } from '../common/decorators/allow-expired-subscription.decorator';
import { DeviceTokensService } from './device-tokens.service';
import { RegisterDeviceTokenDto } from './dto/register-device-token.dto';
import { DeviceTokenParamDto } from './dto/device-token-param.dto';

/**
 * FCM token registration (CAP-1). @AnyMember() (no @UseGuards): guards are
 * global APP_GUARDs, and every handler scopes to the JWT's own user — a
 * person with no company yet may still hold a device that must hear
 * nothing (no rows are pushed while they have no active membership).
 *
 * Both routes answer 204 with NO body: the app treats push registration
 * as fire-and-forget bookkeeping (failures are logged client-side and
 * retried on the next start) and must never branch on a response shape.
 */
@ApiTags('Device tokens')
@ApiBearerAuth()
@AnyMember()
@Controller('device-tokens')
export class DeviceTokensController {
  constructor(private readonly deviceTokensService: DeviceTokensService) {}

  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      "Register (or rebind) the caller's FCM token — idempotent upsert on the token",
    description:
      'Bound to the JWT identity (never a body field): a token already held ' +
      'by another user is rebound to the caller. Ask again on every sign-in ' +
      'and on token rotation.',
  })
  @ApiResponse({ status: 204, description: 'Registered (or already present)' })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 422, description: 'Validation error' })
  @ApiResponse({ status: 500, description: 'Could not store the token' })
  async register(
    @CurrentUser() user: RequestUser,
    @Body() dto: RegisterDeviceTokenDto,
  ): Promise<void> {
    await this.deviceTokensService.register(user, dto);
  }

  // Logout must work for an owner of an expired company (CAP-2), so this
  // one DELETE is exempt from the 402 guard. Registration (POST) is not.
  @Delete(':token')
  @AllowExpiredSubscription()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: "Delete the caller's own token row (idempotent)",
    description:
      "Logout path. Another user's row for the same token is invisible; " +
      'deleting an unknown token is still 204 so retries never surface errors.',
  })
  @ApiResponse({ status: 204, description: 'Deleted (or never present)' })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 422, description: 'Validation error' })
  async unregister(
    @CurrentUser() user: RequestUser,
    @Param() params: DeviceTokenParamDto,
  ): Promise<void> {
    await this.deviceTokensService.unregister(user, params.token);
  }
}
