import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Query,
  Param,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiHeader,
} from '@nestjs/swagger';
import { JobsService } from './jobs.service';
import { WorkflowService } from './workflow.service';
import { AttachmentsService } from './attachments.service';
import { CreateJobDto } from './dto/create-job.dto';
import { UpdateJobDto } from './dto/update-job.dto';
import { ListJobsQueryDto } from './dto/list-jobs-query.dto';
import { AdvanceWorkflowDto } from './dto/advance-workflow.dto';
import { UploadAttachmentDto } from './dto/upload-attachment.dto';
import { ConfirmAttachmentDto } from './dto/confirm-attachment.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { Can } from '../common/decorators/can.decorator';

@ApiTags('Jobs')
@ApiBearerAuth()
@Controller('jobs')
export class JobsController {
  constructor(
    private readonly jobsService: JobsService,
    private readonly workflowService: WorkflowService,
    private readonly attachmentsService: AttachmentsService,
  ) {}

  @Post()
  @Can('job.write')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a job for a customer and assign it to a technician',
  })
  @ApiResponse({ status: 201, description: 'Job created' })
  @ApiResponse({ status: 400, description: 'Company not set up' })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — Technician JWT' })
  @ApiResponse({ status: 404, description: 'Customer or technician not found' })
  @ApiResponse({ status: 422, description: 'Validation error' })
  createJob(@CurrentUser() user: RequestUser, @Body() dto: CreateJobDto) {
    return this.jobsService.createJob(user, dto);
  }

  @Get()
  @Can('job.read_all', 'job.read_own')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'List jobs: scope=today (default, IST day, date-reanchorable) | upcoming | overdue | history; filters by status and technician',
  })
  @ApiResponse({ status: 200, description: 'Cursor-paginated job list' })
  @ApiResponse({ status: 400, description: 'Company not set up / bad cursor' })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 422, description: 'Validation error' })
  listJobs(@CurrentUser() user: RequestUser, @Query() query: ListJobsQueryDto) {
    return this.jobsService.listJobs(user, query);
  }

  // NOTE: `:id` must stay BELOW the parameterless `@Get()` list route above —
  // it is a catch-all that would otherwise shadow `GET /jobs`.
  @Get(':id')
  @Can('job.read_all', 'job.read_own')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Get full job detail: technician & customer profiles, activity log, attachments',
  })
  @ApiResponse({ status: 200, description: 'Full job detail' })
  @ApiResponse({
    status: 400,
    description: 'Company not set up or malformed id',
  })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({
    status: 403,
    description: 'Forbidden — Technician viewing a job not assigned to them',
  })
  @ApiResponse({ status: 404, description: 'Job not found (or other tenant)' })
  getJobDetail(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.jobsService.getJobDetail(user, id);
  }

  @Patch(':id')
  @Can('job.write')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Edit, reassign, or cancel a scheduled job',
  })
  @ApiResponse({ status: 200, description: 'Updated job' })
  @ApiResponse({
    status: 400,
    description: 'Company not set up or malformed id',
  })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — Technician JWT' })
  @ApiResponse({ status: 404, description: 'Job or technician not found' })
  @ApiResponse({
    status: 409,
    description: 'Job is not modifiable in its current status',
  })
  @ApiResponse({ status: 422, description: 'Validation error' })
  updateJob(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateJobDto,
  ) {
    return this.jobsService.updateJob(user, id, dto);
  }

  @Post(':id/workflow')
  @Can('job.advance')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(IdempotencyInterceptor)
  @ApiOperation({
    summary:
      'Advance a job through its ordered workflow steps (assigned technician)',
  })
  @ApiHeader({
    name: 'X-Idempotency-Key',
    required: false,
    description:
      'UUID v4 — 24h replay dedup; re-submitting returns the original response',
  })
  @ApiResponse({
    status: 200,
    description: 'Updated job after the step advance',
  })
  @ApiResponse({
    status: 400,
    description: 'Company not set up or malformed id',
  })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({
    status: 403,
    description: 'Forbidden — Owner JWT, or technician not assigned to the job',
  })
  @ApiResponse({ status: 404, description: 'Job not found (or other tenant)' })
  @ApiResponse({
    status: 409,
    description: 'Job is not advanceable in its current status',
  })
  @ApiResponse({
    status: 422,
    description: 'Invalid step value or out-of-order workflow transition',
  })
  advanceWorkflow(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdvanceWorkflowDto,
  ) {
    return this.workflowService.advanceWorkflowStep(user, id, dto);
  }

  @Post(':id/attachments')
  @Can('job.advance')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(IdempotencyInterceptor)
  @ApiOperation({
    summary: 'Request a presigned R2 upload URL for a job attachment',
  })
  @ApiHeader({
    name: 'X-Idempotency-Key',
    required: false,
    description: 'UUID v4 — 24h replay dedup',
  })
  @ApiResponse({ status: 200, description: 'Presigned upload URL + uploadId' })
  @ApiResponse({
    status: 400,
    description: 'Company not set up or malformed id',
  })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Job not found' })
  @ApiResponse({ status: 409, description: 'Photo limit reached (5 max)' })
  @ApiResponse({ status: 422, description: 'Validation error' })
  uploadAttachment(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UploadAttachmentDto,
  ) {
    return this.attachmentsService.requestUpload(user, id, dto);
  }

  @Post(':id/attachments/:uploadId/confirm')
  @Can('job.advance')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Confirm a completed R2 upload (Phase 2 of two-phase upload)',
  })
  @ApiResponse({ status: 200, description: 'Attachment confirmed' })
  @ApiResponse({
    status: 400,
    description: 'Company not set up or malformed id',
  })
  @ApiResponse({ status: 401, description: 'Missing/invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Job or upload not found' })
  @ApiResponse({ status: 410, description: 'Upload session expired' })
  @ApiResponse({ status: 422, description: 'Validation error' })
  confirmUpload(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('uploadId', ParseUUIDPipe) uploadId: string,
    @Body() dto: ConfirmAttachmentDto,
  ) {
    return this.attachmentsService.confirmUpload(user, id, uploadId, dto);
  }
}
