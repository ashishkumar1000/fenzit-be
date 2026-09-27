import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { EnrolmentsService } from './enrolments.service';
import { EnrolmentQueryDto, ReassignOfficeDto, SetEnrolmentDto } from './dto/enrolment.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Role } from '../common/enums/role.enum';
import { ErrorCode } from '../common/enums/error-code.enum';
import { UUID_PATTERN } from '../common/utils/uuid-pattern.util';
import type { RequestUser } from '../common/interfaces/request-user.interface';

/**
 * FR-2/FR-6 enrolment routes (Epic 15, Story 15-7). Owner-only; every
 * write is a single pg transaction (no RPCs — user decision 2026-09-28)
 * and every read answers from the attendance_access_state view. The
 * wizard's per-employee office picks (15-8) and the roster UI (15-9) loop
 * the PUT — there is no bulk route by decision.
 */
@ApiTags('Attendance')
@ApiBearerAuth()
@Controller('attendance/enrolments')
export class EnrolmentsController {
  constructor(private readonly enrolmentsService: EnrolmentsService) {}

  /** Malformed :employeeId → 400 VALIDATION_ERROR before any DB round trip. */
  private requireEmployeeId(id: string): string {
    if (!UUID_PATTERN.test(id)) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid employee id',
      });
    }
    return id;
  }

  @Get()
  @Roles(Role.OWNER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Enrolment roster — per-technician access state, start date, onboarding and office',
  })
  @ApiResponse({
    status: 200,
    description:
      'One row per technician (empty until anyone is enrolled); state comes from the attendance_access_state view.',
  })
  @ApiResponse({
    status: 400,
    description: 'VALIDATION_ERROR — owner without a company (no tenantId)',
  })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — Technician JWT' })
  @ApiResponse({
    status: 404,
    description: 'ATTENDANCE_TENANT_NOT_FOUND — stale/unknown tenant',
  })
  listEnrolments(@CurrentUser() user: RequestUser) {
    return this.enrolmentsService.listEnrolments(user);
  }

  @Put(':employeeId')
  @Roles(Role.OWNER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Enable attendance for one employee (FR-2) — or change/cancel-then-reset a future start date',
  })
  @ApiResponse({
    status: 200,
    description:
      '{ attendanceEnabled, attendanceAccess, attendanceStartDate, enabledAt, onboardedAt, officeId, officeName }',
  })
  @ApiResponse({
    status: 400,
    description: 'VALIDATION_ERROR — malformed employee id / no tenant / bad date',
  })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — Technician JWT' })
  @ApiResponse({
    status: 404,
    description:
      'ATTENDANCE_EMPLOYEE_NOT_FOUND (not a tenant member) or ATTENDANCE_OFFICE_NOT_FOUND / ATTENDANCE_TENANT_NOT_FOUND',
  })
  @ApiResponse({
    status: 409,
    description: 'ATTENDANCE_OFFICE_ARCHIVED — enrol with a live office',
  })
  @ApiResponse({
    status: 422,
    description: 'ATTENDANCE_ASSIGNMENT_GAP — coverage invariant rejected at COMMIT',
  })
  setEnrolment(
    @CurrentUser() user: RequestUser,
    @Param('employeeId') employeeId: string,
    @Body() dto: SetEnrolmentDto,
  ) {
    return this.enrolmentsService.setEnrolment(
      user,
      this.requireEmployeeId(employeeId),
      dto,
    );
  }

  @Put(':employeeId/office')
  @Roles(Role.OWNER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Reassign a tracked employee's office (FR-6) — tomorrow automatically once they've checked in today",
  })
  @ApiResponse({
    status: 200,
    description: 'Post-reassignment access state',
  })
  @ApiResponse({
    status: 400,
    description: 'VALIDATION_ERROR — malformed employee id / no tenant / bad date',
  })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — Technician JWT' })
  @ApiResponse({
    status: 404,
    description: 'ATTENDANCE_EMPLOYEE_NOT_FOUND / ATTENDANCE_OFFICE_NOT_FOUND / ATTENDANCE_TENANT_NOT_FOUND',
  })
  @ApiResponse({
    status: 409,
    description: 'ATTENDANCE_OFFICE_ARCHIVED',
  })
  @ApiResponse({
    status: 422,
    description:
      'ATTENDANCE_ASSIGNMENT_NOT_ENROLLED — no enrolment covers the effective date',
  })
  reassignOffice(
    @CurrentUser() user: RequestUser,
    @Param('employeeId') employeeId: string,
    @Body() dto: ReassignOfficeDto,
  ) {
    return this.enrolmentsService.reassignOffice(
      user,
      this.requireEmployeeId(employeeId),
      dto,
    );
  }

  @Delete(':employeeId')
  @Roles(Role.OWNER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Disable attendance for one employee (FR-2) — history kept read-only; cancelling a future start removes the rows',
  })
  @ApiResponse({
    status: 200,
    description: 'Post-disable state (history_only, or none after cancelling a future start)',
  })
  @ApiResponse({
    status: 400,
    description: 'VALIDATION_ERROR — malformed employee id / no tenant / bad date',
  })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — Technician JWT' })
  @ApiResponse({
    status: 404,
    description: 'ATTENDANCE_EMPLOYEE_NOT_FOUND / ATTENDANCE_TENANT_NOT_FOUND',
  })
  disableEnrolment(
    @CurrentUser() user: RequestUser,
    @Param('employeeId') employeeId: string,
    @Query() query: EnrolmentQueryDto,
  ) {
    return this.enrolmentsService.disableEnrolment(
      user,
      this.requireEmployeeId(employeeId),
      query,
    );
  }
}
