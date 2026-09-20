import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ReportsService } from './reports.service';
import { CreateReportRequestDto } from './dto/create-report-request.dto';
import { ListReportsQueryDto } from './dto/list-reports-query.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';
import { Role } from '../common/enums/role.enum';
import type { RequestUser } from '../common/interfaces/request-user.interface';

@ApiTags('Reports')
@ApiBearerAuth()
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Post()
  @Roles(Role.OWNER)
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(IdempotencyInterceptor)
  @ApiOperation({
    summary:
      'Queue a report request (async generation; poll GET /reports/:id or the history list)',
  })
  @ApiResponse({ status: 201, description: 'Report request queued' })
  @ApiResponse({
    status: 400,
    description: 'Invalid range/technicians/unknown type',
  })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — Technician JWT' })
  @ApiResponse({
    status: 429,
    description: 'Too many reports in flight for the company (max 3)',
  })
  createReport(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateReportRequestDto,
  ) {
    return this.reportsService.createReport(user, dto);
  }

  // NOTE: `:id` must stay BELOW the parameterless `@Get()` list route above —
  // it is a catch-all that would otherwise shadow `GET /reports`.
  @Get()
  @Roles(Role.OWNER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Report history, newest first (cursor-paginated, page 20)',
  })
  @ApiResponse({ status: 200, description: 'Cursor-paginated report history' })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — Technician JWT' })
  listReports(
    @CurrentUser() user: RequestUser,
    @Query() query: ListReportsQueryDto,
  ) {
    return this.reportsService.listReports(user, query);
  }

  @Post(':id/retry')
  @Roles(Role.OWNER)
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(IdempotencyInterceptor)
  @ApiOperation({
    summary: 'Re-queue a failed report request (the same row regenerates)',
  })
  @ApiResponse({ status: 201, description: 'Report request re-queued' })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — Technician JWT' })
  @ApiResponse({ status: 404, description: 'Report not found (or other company)' })
  @ApiResponse({
    status: 409,
    description: 'The request is not in the failed state (nothing to retry)',
  })
  @ApiResponse({
    status: 429,
    description: 'Too many reports in flight for the company (max 3)',
  })
  retryReport(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.reportsService.retryReport(user, id);
  }

  @Get(':id')
  @Roles(Role.OWNER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Report request status; when ready, carries a fresh presigned download URL',
  })
  @ApiResponse({ status: 200, description: 'Report request status' })
  @ApiResponse({
    status: 404,
    description: 'Report not found (or other company)',
  })
  @ApiResponse({ status: 500, description: 'Presigning failed' })
  getReportStatus(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.reportsService.getReportStatus(user, id);
  }
}
