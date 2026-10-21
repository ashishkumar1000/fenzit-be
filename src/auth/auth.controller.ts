import {
  Controller,
  Post,
  Get,
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
  ApiBody,
} from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { AuthService } from './auth.service';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import { SendOtpDto } from './dto/send-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { EmailLoginDto } from './dto/email-login.dto';
import { EmailLoginService } from './email-login.service';
import { EmailLinkService } from './email-link.service';
import { LinkEmailDto } from './dto/link-email.dto';
import { SetupCompanyDto } from './dto/setup-company.dto';
import { InviteMemberDto } from './dto/invite-member.dto';
import { Can } from '../common/decorators/can.decorator';
import { AnyMember } from '../common/decorators/any-member.decorator';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly emailLoginService: EmailLoginService,
    private readonly emailLinkService: EmailLinkService,
  ) {}

  @Public()
  @Post('otp/send')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request OTP for phone number' })
  @ApiResponse({
    status: 200,
    description:
      'OTP handed to the SMS provider. The response never carries the code — testing uses the flag-gated master code.',
    schema: {
      example: {
        otp_session_id: '550e8400-e29b-41d4-a716-446655440000',
        expires_at: '2026-06-19T21:51:00Z',
      },
    },
  })
  @ApiResponse({ status: 422, description: 'Invalid phone number' })
  @ApiResponse({
    status: 429,
    description: 'Rate limit exceeded',
    headers: {
      'Retry-After': {
        description:
          'Seconds remaining in the rate-limit window — wait at least this long before retrying.',
        schema: { type: 'integer' },
      },
    },
  })
  @ApiResponse({
    status: 502,
    description:
      'OTP_SEND_FAILED — the SMS gateway rejected or failed the send. Retryable. The session was deleted unless the outcome was a timeout (the SMS may still arrive).',
  })
  async sendOtp(@Body() dto: SendOtpDto) {
    return this.authService.sendOtp(dto);
  }

  @Public()
  @Post('otp/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify OTP and get JWT' })
  @ApiBody({
    type: VerifyOtpDto,
    description: 'OTP session ID and 4-digit OTP code',
    examples: {
      verification: {
        value: {
          otpSessionId: '550e8400-e29b-41d4-a716-446655440000',
          otpCode: '1234',
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'OTP verified successfully',
    schema: {
      example: {
        token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
        user: {
          userId: '550e8400-e29b-41d4-a716-446655440000',
          tenantId: null,
          role: null,
          name: null,
          platformAdmin: false,
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

  // DEV SHORTCUT — remove at go-live gate (see email-login.constants.ts)
  @Public()
  @Post('email/login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Log in with email and the fixed development password',
  })
  @ApiResponse({
    status: 200,
    description:
      'Signed in. Same body as otp/verify. Signs in an existing user only; never creates one.',
    schema: {
      example: {
        token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
        user: {
          userId: '550e8400-e29b-41d4-a716-446655440000',
          tenantId: null,
          role: 'platform_admin',
          name: null,
          platformAdmin: true,
        },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description:
      'Wrong password, unknown email or disabled user (one generic answer)',
  })
  @ApiResponse({ status: 422, description: 'Malformed or missing fields' })
  @ApiResponse({
    status: 429,
    description: 'Too many failed attempts for this email (Retry-After)',
  })
  async emailLogin(@Body() dto: EmailLoginDto) {
    return this.emailLoginService.login(dto);
  }

  @Post('email/link')
  @AnyMember()
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Link an email address to the signed-in user',
    description:
      'Any signed-in person, with or without a company. One email belongs to one user; a second user asking for the same email gets 409.',
  })
  @ApiResponse({
    status: 200,
    description: 'Email linked',
    schema: { example: { email: 'owner@example.com' } },
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid JWT' })
  @ApiResponse({
    status: 409,
    description:
      'Another user already has this email, or this account already has a different email',
  })
  @ApiResponse({ status: 422, description: 'Email is not a valid address' })
  @ApiResponse({ status: 429, description: 'Too many "already taken" answers for this account' })
  @ApiResponse({ status: 404, description: 'The signed-in user row was not found' })
  @ApiResponse({ status: 500, description: 'The email could not be saved' })
  async linkEmail(@CurrentUser() user: RequestUser, @Body() dto: LinkEmailDto) {
    return this.emailLinkService.link(user.userId, dto.email);
  }

  @Post('invite')
  @Can('member.invite')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Invite a person to the company by phone number' })
  @ApiResponse({
    status: 201,
    description:
      'Invite created — an invited membership for the person, with their employee code',
    schema: {
      example: {
        invite_id: '550e8400-e29b-41d4-a716-446655440000',
        employee_code: 'EMP-002',
      },
    },
  })
  @ApiResponse({ status: 403, description: 'Forbidden — not a company admin' })
  @ApiResponse({
    status: 409,
    description: 'The person already belongs to a company',
  })
  @ApiResponse({
    status: 422,
    description: 'Validation error — invalid skillIds or phone format',
  })
  async inviteMember(
    @CurrentUser() user: RequestUser,
    @Body() dto: InviteMemberDto,
  ) {
    return this.authService.inviteMember(user, dto);
  }

  @Post('company')
  @Can('company.create_own', 'company.manage')
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
  @ApiResponse({ status: 403, description: 'Forbidden — not a company admin or platform admin' })
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

  @Get('realtime-token')
  @AnyMember()
  // Any signed-in person (Story 14.2): the channel is per-user, not per-role.
  // AD-18's security gate is satisfied by Story 14-1 (RPC grants revoked,
  // users_update_own column-limited). Token scoping needs no change: the
  // sub-keyed realtime.messages policy (notifications_topic_recipient_only)
  // already denies any foreign topic server-side, so a technician token can
  // only ever receive their own user:<sub>:notifications topic.
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Mint a short-lived Supabase Realtime token' })
  @ApiResponse({
    status: 200,
    description:
      'One-hour token carrying sub + role: "authenticated" + exp — the claim set Supabase Realtime accepts (the login JWT is rejected: no exp, role is not a Postgres role). Issued to every signed-in member; each token can only reach its own user topic.',
    schema: {
      example: {
        token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
        expiresAt: '2026-09-09T20:00:00.000Z',
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid JWT' })
  async realtimeToken(@CurrentUser() user: RequestUser) {
    return this.authService.mintRealtimeToken(user);
  }
}
