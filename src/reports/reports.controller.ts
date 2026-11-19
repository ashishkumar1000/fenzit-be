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
import { ReportQueueService } from './report-queue.service';
import { CreateReportRequestDto } from './dto/create-report-request.dto';
import { ListReportsQueryDto } from './dto/list-reports-query.dto';
import { ReportQueuePauseDto } from './dto/report-queue-pause.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { Can } from '../common/decorators/can.decorator';

@ApiTags('Reports')
@ApiBearerAuth()
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reportsService: ReportsService,
    private readonly queue: ReportQueueService,
  ) {}

  @Post()
  @Can('report.request')
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

  // NOTE: the `queue/...` routes must stay ABOVE the `:id` routes below —
  // `:id` is a catch-all that would otherwise swallow the literal path
  // (and trip the uuid pipe on the word "queue").
  @Get('queue/status')
  @Can('report.read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Is the report queue paused? pausedUntil null while paused = indefinitely',
  })
  @ApiResponse({ status: 200, description: 'The pause state' })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  getQueueStatus(@CurrentUser() user: RequestUser) {
    return this.queue.getState(user);
  }

  @Post('queue/pause')
  @Can('report.queue')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Pause report generation (body minutes = timed pause; omit = indefinitely)',
  })
  @ApiResponse({
    status: 200,
    description: 'The pause state after pausing',
  })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({
    status: 403,
    description:
      'Forbidden — pause/resume needs the report.queue permission (company admin)',
  })
  @ApiResponse({ status: 422, description: 'minutes outside 1–1440' })
  pauseQueue(
    @CurrentUser() user: RequestUser,
    @Body() dto: ReportQueuePauseDto,
  ) {
    return this.queue.pause(user, dto.minutes ?? null);
  }

  @Post('queue/resume')
  @Can('report.queue')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'End the pause — claims resume on the next tick' })
  @ApiResponse({ status: 200, description: 'The pause state after resuming' })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({
    status: 403,
    description:
      'Forbidden — pause/resume needs the report.queue permission (company admin)',
  })
  resumeQueue(@CurrentUser() user: RequestUser) {
    return this.queue.resume(user);
  }

  // NOTE: `:id` must stay BELOW the parameterless `@Get()` list route above —
  // it is a catch-all that would otherwise shadow `GET /reports`.
  @Get()
  @Can('report.read')
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
  @Can('report.request')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(IdempotencyInterceptor)
  @ApiOperation({
    summary: 'Re-queue a failed report request (the same row regenerates)',
  })
  @ApiResponse({ status: 201, description: 'Report request re-queued' })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — Technician JWT' })
  @ApiResponse({
    status: 404,
    description: 'Report not found (or other company)',
  })
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
  @Can('report.read')
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
