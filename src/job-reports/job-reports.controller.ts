import { Controller, Get, HttpCode, HttpStatus, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Can } from '../common/decorators/can.decorator';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { JobReportsService } from './job-reports.service';
import { ApprovalQueueService } from './approval-queue.service';
import { JobReportRangeDto } from './dto/job-report-range.dto';
import { ApprovalQueueQueryDto } from './dto/approval-queue-query.dto';
import { OwnPendingQueryDto } from './dto/own-pending-query.dto';

@ApiTags('Job reports')
@ApiBearerAuth()
@Controller('job-reports')
export class JobReportsController {
  constructor(private readonly jobReportsService: JobReportsService) {}

  // Owner only: job.approve is granted to company admins alone.
  @Get('owner')
  @Can('job.approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Owner report: headline counts, approval pipeline and per-employee breakdown for an IST date window',
  })
  @ApiResponse({ status: 200, description: 'Owner report' })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({
    status: 403,
    description: 'Not a company admin of this company',
  })
  @ApiResponse({ status: 422, description: 'Window not valid' })
  ownerReport(
    @CurrentUser() user: RequestUser,
    @Query() query: JobReportRangeDto,
  ) {
    return this.jobReportsService.ownerReport(user, query);
  }

  // Employee: only the employee's own numbers, never another employee's.
  @Get('employee')
  @Can('job.read_own')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Employee report: my created-job outcomes, approval rate, wait for a decision, and rejection reasons',
  })
  @ApiResponse({ status: 200, description: 'Employee report' })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 403, description: 'Not an employee of this company' })
  @ApiResponse({ status: 422, description: 'Window not valid' })
  employeeReport(
    @CurrentUser() user: RequestUser,
    @Query() query: JobReportRangeDto,
  ) {
    return this.jobReportsService.employeeReport(user, query);
  }
}

@ApiTags('Job reports')
@ApiBearerAuth()
@Controller('approval-queue')
export class ApprovalQueueController {
  constructor(private readonly approvalQueueService: ApprovalQueueService) {}

  // Employee: the caller's own pending jobs. The id comes from the token, never the URL.
  @Get('mine')
  @Can('job.read_own')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'My pending jobs: jobs I created that wait for owner approval, oldest first',
  })
  @ApiResponse({ status: 200, description: 'Cursor-paginated pending jobs' })
  @ApiResponse({ status: 403, description: 'Not an employee of this company' })
  listMine(@CurrentUser() user: RequestUser, @Query() query: OwnPendingQueryDto) {
    return this.approvalQueueService.listOwn(user, query);
  }

  @Get()
  @Can('job.approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Owner approval queue: pending employee jobs, oldest first; filter by employee and submission age (filters combine)',
  })
  @ApiResponse({ status: 200, description: 'Cursor-paginated approval queue' })
  @ApiResponse({ status: 400, description: 'Company not set up / bad cursor' })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({
    status: 403,
    description: 'Not a company admin of this company',
  })
  @ApiResponse({ status: 422, description: 'Validation error' })
  list(
    @CurrentUser() user: RequestUser,
    @Query() query: ApprovalQueueQueryDto,
  ) {
    return this.approvalQueueService.list(user, query);
  }
}
