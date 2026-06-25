import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  Res,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { AuthService } from './auth.service';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import { SendOtpDto } from './dto/send-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { SetupCompanyDto } from './dto/setup-company.dto';
import { InviteTechnicianDto } from './dto/invite-technician.dto';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('otp/send')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request OTP for phone number' })
  @ApiResponse({
    status: 200,
    description: 'OTP sent successfully',
    schema: {
      example: {
        otp_session_id: '550e8400-e29b-41d4-a716-446655440000',
        expires_at: '2026-06-19T21:51:00Z',
      },
    },
  })
  @ApiResponse({ status: 422, description: 'Invalid phone number' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  async sendOtp(@Body() dto: SendOtpDto) {
    return this.authService.sendOtp(dto);
  }

  @Public()
  @Post('otp/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify OTP and get JWT' })
  @ApiResponse({
    status: 200,
    description: 'OTP verified successfully',
    schema: {
      example: {
        token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
        user: {
          userId: '550e8400-e29b-41d4-a716-446655440000',
          tenantId: null,
          role: 'owner',
          name: null,
        },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid, expired, or locked OTP session',
  })
  @ApiResponse({ status: 422, description: 'Invalid OTP code format' })
  async verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.authService.verifyOtp(dto);
  }

  @Post('invite')
  @Roles(Role.OWNER)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Invite a technician by phone number' })
  @ApiResponse({
    status: 201,
    description:
      'Invite created — technician user record created with status: invited',
    schema: { example: { invite_id: '550e8400-e29b-41d4-a716-446655440000' } },
  })
  @ApiResponse({ status: 403, description: 'Forbidden — Technician JWT' })
  @ApiResponse({
    status: 409,
    description: 'Phone already an active member of this tenant',
  })
  @ApiResponse({
    status: 422,
    description: 'Validation error — invalid skillType or phone format',
  })
  async inviteTechnician(
    @CurrentUser() user: RequestUser,
    @Body() dto: InviteTechnicianDto,
  ) {
    return this.authService.inviteTechnician(user, dto);
  }

  @Post('company')
  @Roles(Role.OWNER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create or update company profile (idempotent)' })
  @ApiResponse({
    status: 201,
    description: 'Company created — tenant linked to owner for the first time',
  })
  @ApiResponse({
    status: 200,
    description: 'Company updated — idempotent upsert, tenant already existed',
  })
  @ApiResponse({ status: 403, description: 'Forbidden — Technician JWT' })
  @ApiResponse({
    status: 422,
    description: 'Validation error (invalid GSTIN, missing stateCode)',
  })
  async setupCompany(
    @CurrentUser() user: RequestUser,
    @Body() dto: SetupCompanyDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { tenant, created, token } = await this.authService.setupCompany(
      user,
      dto,
    );
    reply.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return { token, tenant };
  }
}
