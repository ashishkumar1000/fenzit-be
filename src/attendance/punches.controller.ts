import { Controller, Get, HttpCode, HttpStatus, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { Can } from '../common/decorators/can.decorator';
import { PunchesService } from './punches.read';
import { DayStatusesQueryDto } from './dto/correction.dto';

/**
 * The admin punch-history route (employee profile story): one employee's
 * check-in/out rows for a range, the profile tab's "Punch history" card.
 * Same shape contract as day-statuses (employeeId/from/to + the 62-day span
 * cap validated before the transaction); the rows themselves come from the
 * shared day-status grid so corrections and overrides stay consistent.
 */
@ApiTags('Attendance')
@ApiBearerAuth()
@Controller('attendance')
export class PunchesController {
  constructor(private readonly punchesService: PunchesService) {}

  @Get('punches')
  @Can('attendance.read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'One employee’s punch history for a range (check-in/out instants, GPS distances, day status; from ≤ to, span ≤ 62 days)',
  })
  @ApiResponse({
    status: 200,
    description:
      '{ employeeId, from, to, today, punches: PunchRow[] } — only days that carry a punch, newest first',
  })
  @ApiResponse({
    status: 404,
    description:
      'ATTENDANCE_EMPLOYEE_NOT_FOUND — employee outside this tenant (no existence leak)',
  })
  @ApiResponse({
    status: 422,
    description: 'ATTENDANCE_INVALID_RANGE (from > to, or span > 62 days)',
  })
  list(@CurrentUser() owner: RequestUser, @Query() query: DayStatusesQueryDto) {
    return this.punchesService.listForOwner(
      owner,
      query.employeeId,
      query.from,
      query.to,
    );
  }
}
