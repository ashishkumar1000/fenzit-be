import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { AttendanceService } from './attendance.service';
import { UpdateSetupStepDto } from './dto/update-setup-step.dto';
import { SetupStateResponse } from './attendance-response.model';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Role } from '../common/enums/role.enum';
import type { RequestUser } from '../common/interfaces/request-user.interface';

/**
 * FR-1 setup wizard routes (Epic 15, Story 15-2). Owner-only; the
 * technician entry point is `me/access` in a later story. No idempotency
 * interceptor (AD-6): start/step-save are idempotent by construction and
 * complete is state-guarded.
 */
@ApiTags('Attendance')
@ApiBearerAuth()
@Controller('attendance/setup')
export class AttendanceController {
  constructor(private readonly attendanceService: AttendanceService) {}

  @Get()
  @Roles(Role.OWNER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Setup wizard resume state — started=false until the wizard is started',
  })
  @ApiResponse({ status: 200, description: 'Setup state (started may be false)' })
  @ApiResponse({ status: 400, description: 'VALIDATION_ERROR — owner without a company (no tenantId)' })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — Technician JWT' })
  getSetupState(@CurrentUser() user: RequestUser) {
    return this.attendanceService.getSetupState(user);
  }

  @Post()
  @Roles(Role.OWNER)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Start (or resume) the setup wizard — idempotent, never resets progress',
  })
  @ApiResponse({
    status: 201,
    description: 'Wizard started (first time); returns the current state',
  })
  @ApiResponse({ status: 200, description: 'Wizard already under way' })
  @ApiResponse({ status: 400, description: 'VALIDATION_ERROR — owner without a company (no tenantId)' })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — Technician JWT' })
  @ApiResponse({ status: 409, description: 'Setup already completed' })
  @ApiResponse({ status: 500, description: 'INTERNAL_SERVER_ERROR — start RPC failed' })
  async startSetup(
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SetupStateResponse> {
    // 201 on first start, 200 when the wizard was already under way —
    // picked from the service's `created` flag, so the route can't carry a
    // fixed @HttpCode.
    const { state, created } = await this.attendanceService.startSetup(user);
    reply.code(created ? HttpStatus.CREATED : HttpStatus.OK);
    return state;
  }

  @Patch()
  @Roles(Role.OWNER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Persist the wizard step the owner is now on (FR-1 progress)',
  })
  @ApiResponse({ status: 200, description: 'Step saved' })
  @ApiResponse({ status: 400, description: 'VALIDATION_ERROR — owner without a company (no tenantId)' })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — Technician JWT' })
  @ApiResponse({ status: 404, description: 'Setup not started' })
  @ApiResponse({ status: 409, description: 'Setup already completed' })
  @ApiResponse({ status: 422, description: 'Unknown step value' })
  @ApiResponse({ status: 500, description: 'INTERNAL_SERVER_ERROR — step save failed' })
  saveStep(@CurrentUser() user: RequestUser, @Body() dto: UpdateSetupStepDto) {
    return this.attendanceService.saveStep(user, dto);
  }

  @Post('complete')
  @Roles(Role.OWNER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Complete the wizard — needs ≥1 office and ≥1 tracked employee with an office assignment',
  })
  @ApiResponse({ status: 200, description: 'Setup completed (enabled = true)' })
  @ApiResponse({ status: 400, description: 'VALIDATION_ERROR — owner without a company (no tenantId)' })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — Technician JWT' })
  @ApiResponse({ status: 404, description: 'Setup not started' })
  @ApiResponse({ status: 409, description: 'Setup already completed' })
  @ApiResponse({
    status: 422,
    description: 'Gates unmet — no office or no tracked employee with an assignment',
  })
  @ApiResponse({ status: 500, description: 'INTERNAL_SERVER_ERROR — completion RPC failed' })
  completeSetup(@CurrentUser() user: RequestUser) {
    return this.attendanceService.completeSetup(user);
  }
}