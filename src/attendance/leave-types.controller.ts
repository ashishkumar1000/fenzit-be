import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Can } from '../common/decorators/can.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import {
  CreateLeaveTypeDto,
  LeaveTypeCreatedView,
  LeaveTypeView,
  UpdateLeaveTypeDto,
} from './dto/leave-type.dto';
import { LeaveTypesService } from './leave-types.service';

/**
 * The company's paid/unpaid leave-type catalog (CAP-12). Company-admin only
 * (`leave.types` sits outside ADMIN_PERMISSIONS — tenant payroll config is
 * not platform-staff business). Plain table writes, no database functions;
 * one audit entry per mutation.
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
      'The company leave catalog, name-ascending: each type is a name plus its paid marking',
  })
  @ApiOkResponse({
    type: [LeaveTypeView],
    description: 'Every type of this company (possibly empty)',
  })
  @ApiResponse({ status: 403, description: 'Not a company admin' })
  list(@CurrentUser() user: RequestUser) {
    return this.leaveTypesService.list(user);
  }

  @Post()
  @Can('leave.types')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Add a type. Without an explicit paid flag the marking defaults by keyword: casual/sick/earned → paid, unpaid/LOP → unpaid, anything else → paid — the answer says which default it applied.',
  })
  @ApiCreatedResponse({
    type: LeaveTypeCreatedView,
    description: 'The created type, with appliedDefault when one was applied',
  })
  @ApiResponse({
    status: 409,
    description: 'A type with this name already exists in the company',
  })
  @ApiResponse({
    status: 422,
    description: 'Bad name (empty or over 60 characters) or a non-boolean paid',
  })
  @ApiResponse({ status: 403, description: 'Not a company admin' })
  create(@CurrentUser() user: RequestUser, @Body() dto: CreateLeaveTypeDto) {
    return this.leaveTypesService.create(user, dto);
  }

  @Patch(':id')
  @Can('leave.types')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Rename a type and/or flip its paid marking. Neither field can be cleared — null is refused.',
  })
  @ApiOkResponse({
    type: LeaveTypeView,
    description: 'The type as now stored',
  })
  @ApiResponse({
    status: 409,
    description: 'The new name is already used by another type',
  })
  @ApiResponse({
    status: 422,
    description: 'name or paid sent as null (no clear verb)',
  })
  @ApiResponse({ status: 404, description: 'The type is not in this company' })
  @ApiResponse({ status: 403, description: 'Not a company admin' })
  update(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLeaveTypeDto,
  ) {
    return this.leaveTypesService.update(user, id, dto);
  }

  @Delete(':id')
  @Can('leave.types')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Remove an unused type. A type that existing leave requests reference is refused — retype those requests first.',
  })
  @ApiResponse({ status: 204, description: 'Deleted' })
  @ApiResponse({
    status: 409,
    description: 'The type is referenced by existing leave requests',
  })
  @ApiResponse({ status: 404, description: 'The type is not in this company' })
  @ApiResponse({ status: 403, description: 'Not a company admin' })
  remove(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.leaveTypesService.remove(user, id);
  }
}
