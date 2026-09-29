import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Role } from '../common/enums/role.enum';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { CorrectionsService } from './corrections.service';
import {
  AcknowledgeDto,
  ListCorrectionsQueryDto,
  PutCorrectionDto,
} from './dto/correction.dto';

/**
 * The corrections routes (18-2). Owner class-level; the `me` history read
 * is a method-level @Roles(Role.TECHNICIAN) override (RolesGuard
 * getAllAndOverride). Cross-tenant ids 404 with no existence leak (D6).
 */
@ApiTags('Attendance')
@ApiBearerAuth()
@Controller('attendance')
@Roles(Role.OWNER)
export class CorrectionsController {
  constructor(private readonly correctionsService: CorrectionsService) {}

  @Put('corrections/:employeeId/:workDate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'FR-21 correct a day: exactly one of status XOR check-in/out instants; appends one audit row, originals stay untouched',
  })
  @ApiResponse({
    status: 200,
    description:
      '{ workDate, override, correctedAt, actorId } — the recompute-live response (next reads show the correction)',
  })
  @ApiResponse({
    status: 404,
    description: 'ATTENDANCE_EMPLOYEE_NOT_FOUND — employee outside this tenant',
  })
  @ApiResponse({
    status: 422,
    description:
      'ATTENDANCE_FUTURE_DATE | ATTENDANCE_DATE_NOT_TRACKED | ATTENDANCE_INVALID_RANGE | VALIDATION_ERROR (mixed arms, note hygiene)',
  })
  putCorrection(
    @CurrentUser() owner: RequestUser,
    // :employeeId and :workDate shapes are service-level 422s
    // (VALIDATION_ERROR) — no param-level ParseUUIDPipe 400 (review G2-P8).
    @Param('employeeId') employeeId: string,
    @Param('workDate') workDate: string,
    @Body() dto: PutCorrectionDto,
  ) {
    return this.correctionsService.put(owner, employeeId, workDate, dto, dto.note);
  }

  @Delete('corrections/:employeeId/:workDate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'FR-21 remove a correction (soft delete) — the underlying record state shows through again; own retries answer 200 { deleted: false }',
  })
  @ApiResponse({ status: 200, description: '{ deleted: boolean }' })
  @ApiResponse({
    status: 404,
    description: 'ATTENDANCE_EMPLOYEE_NOT_FOUND — employee outside this tenant',
  })
  @ApiResponse({
    status: 422,
    description: 'ATTENDANCE_DATE_NOT_TRACKED (a non-tracked date has nothing to remove)',
  })
  removeCorrection(
    @CurrentUser() owner: RequestUser,
    // :employeeId and :workDate shapes are service-level 422s
    // (VALIDATION_ERROR) — no param-level ParseUUIDPipe 400 (review G2-P8).
    @Param('employeeId') employeeId: string,
    @Param('workDate') workDate: string,
  ) {
    return this.correctionsService.remove(owner, employeeId, workDate);
  }

  @Get('corrections')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'FR-21 the owner-visible correction history (employeeId required; optional workDate filter), cursor-paginated',
  })
  @ApiResponse({
    status: 200,
    description: 'PaginatedResponse<CorrectionEntry>, newest first',
  })
  listCorrections(
    @CurrentUser() owner: RequestUser,
    // employeeId shape is the service-level 422 (VALIDATION_ERROR) again.
    @Query('employeeId') employeeId: string,
    @Query() query: ListCorrectionsQueryDto,
  ) {
    return this.correctionsService.listOwner(owner, employeeId, query);
  }

  @Post('attempts/acknowledge')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'AD-10 acknowledge the fake-location attempts on an employee-date — clears the day marker; the attempt rows are kept',
  })
  @ApiResponse({ status: 200, description: '{ acknowledgedCount } (200 even at 0)' })
  @ApiResponse({
    status: 404,
    description: 'ATTENDANCE_EMPLOYEE_NOT_FOUND — employee outside this tenant',
  })
  acknowledgeAttempts(
    @CurrentUser() owner: RequestUser,
    @Body() dto: AcknowledgeDto,
  ) {
    return this.correctionsService.acknowledge(
      owner,
      dto.employeeId,
      dto.workDate,
    );
  }

  /** The technician's own correction history (identity from the JWT). */
  @Get('me/corrections')
  @Roles(Role.TECHNICIAN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'FR-21 my correction history (own entries only, optional workDate filter)',
  })
  @ApiResponse({
    status: 200,
    description: 'PaginatedResponse<CorrectionEntry>, newest first',
  })
  listMyCorrections(
    @CurrentUser() user: RequestUser,
    @Query() query: ListCorrectionsQueryDto,
  ) {
    return this.correctionsService.listMine(user, query);
  }
}
