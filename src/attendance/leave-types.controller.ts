import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Can } from '../common/decorators/can.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { LeaveTypeView, PatchLeaveTypeValuesDto } from './dto/leave-type.dto';
import { LeaveTypesService } from './leave-types.service';

/**
 * The company's FIXED leave-type catalog (23-13). Every company carries
 * exactly Earned Leave, Sick Leave, Bereavement and Comp-Off — types
 * cannot be created or deleted (those routes retired), so the owner edits
 * VALUES only. Company-admin only (`leave.types` sits outside
 * ADMIN_PERMISSIONS — tenant payroll config is not platform-staff
 * business). Plain table writes, no database functions; one audit entry
 * per mutation.
 */
@ApiTags('Attendance')
@ApiBearerAuth()
@Controller('attendance/leave/types')
export class LeaveTypesController {
  constructor(private readonly leaveTypesService: LeaveTypesService) {}

  @Get()
  @Can('leave.types')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'The company leave catalog: the fixed four types (plus any legacy remnants kept read-only), name-ascending',
  })
  @ApiOkResponse({
    type: [LeaveTypeView],
    description: 'Every type of this company',
  })
  @ApiResponse({ status: 403, description: 'Not a company admin' })
  list(@CurrentUser() user: RequestUser) {
    return this.leaveTypesService.list(user);
  }

  @Patch(':id')
  @Can('leave.types')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Edit a type's VALUES: accrual rate/grant, carry-forward, over-balance, paid, enabled. Names, codes and accrual modes are inherent to the fixed catalog; a legacy remnant is read-only.",
  })
  @ApiOkResponse({
    type: LeaveTypeView,
    description:
      'The type as now stored (the unchanged answer carries no audit entry)',
  })
  @ApiResponse({
    status: 409,
    description: 'The type is a legacy remnant (LEAVE_TYPE_NOT_CONFIGURABLE)',
  })
  @ApiResponse({
    status: 422,
    description:
      'accrualDays above 0 on Comp-Off, or carryForward/allowOverBalance on a non-monthly type, or bad values',
  })
  @ApiResponse({ status: 404, description: 'The type is not in this company' })
  @ApiResponse({ status: 403, description: 'Not a company admin' })
  patchValues(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PatchLeaveTypeValuesDto,
  ) {
    return this.leaveTypesService.patchValues(user, id, dto);
  }
}
