import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { ErrorCode } from '../common/enums/error-code.enum';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { JobsService, JobResponse, JobRow } from './jobs.service';
import { AdvanceWorkflowDto } from './dto/advance-workflow.dto';
import { WorkflowStep } from './enums/workflow-step.enum';
import { JobStatus } from './enums/job-status.enum';

/** The 6 workflow steps in canonical order. A fresh job has current_step = null,
 *  so the first valid advance is on_my_way (index 0). */
const STEP_ORDER: WorkflowStep[] = [
  WorkflowStep.ON_MY_WAY,
  WorkflowStep.ARRIVED,
  WorkflowStep.IN_PROGRESS,
  WorkflowStep.PHOTOS_UPLOADED,
  WorkflowStep.SIGNATURE_CAPTURED,
  WorkflowStep.COMPLETED,
];

/** Columns needed to gate + advance the workflow. */
interface WorkflowJobRow {
  id: string;
  tenant_id: string;
  status: JobStatus;
  current_step: string | null;
  require_completion_photo: boolean;
  technician_id: string;
}

@Injectable()
export class WorkflowService {
  private readonly logger = new Logger(WorkflowService.name);

  constructor(
    private readonly supabaseClientFactory: SupabaseClientFactory,
    private readonly jobsService: JobsService,
  ) {}

  /**
   * Pure step-ordering rule. The requested step must be the immediate successor
   * of the current step, with one exception: photos_uploaded may be skipped
   * (signature_captured directly after in_progress) only when a completion photo
   * is NOT required.
   */
  validateStep(
    currentStep: string | null,
    requested: WorkflowStep,
    requireCompletionPhoto: boolean,
  ): boolean {
    const curIdx =
      currentStep === null
        ? -1
        : STEP_ORDER.indexOf(currentStep as WorkflowStep);
    const reqIdx = STEP_ORDER.indexOf(requested);

    // A non-null current_step that is not a recognized step is corrupt — never
    // treat it as the fresh-job (-1) case, which would let on_my_way through and
    // silently reset the workflow.
    if (currentStep !== null && curIdx === -1) {
      return false;
    }

    // Normal advance: exactly one step forward.
    if (reqIdx === curIdx + 1) {
      return true;
    }

    // Photo skip: in_progress → signature_captured when no photo is required.
    if (
      !requireCompletionPhoto &&
      requested === WorkflowStep.SIGNATURE_CAPTURED &&
      currentStep === WorkflowStep.IN_PROGRESS
    ) {
      return true;
    }

    return false;
  }

  async advanceWorkflowStep(
    user: RequestUser,
    jobId: string,
    dto: AdvanceWorkflowDto,
  ): Promise<JobResponse> {
    // Company must be set up (400, not 422) — consistent with the other jobs reads.
    if (!user.tenantId) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Company setup required before advancing jobs',
      });
    }

    const admin = this.supabaseClientFactory.createAdmin();

    // 1) Fetch + tenant gate. Real DB error → 500 FIRST; PGRST116 / empty /
    //    cross-tenant → 404 (never 403). Mirrors getJobDetail.
    const { data: row, error } = await admin
      .from('jobs')
      .select(
        'id, tenant_id, status, current_step, require_completion_photo, technician_id',
      )
      .eq('id', jobId)
      .eq('tenant_id', user.tenantId)
      .single<WorkflowJobRow>();

    if (error && error.code !== 'PGRST116') {
      this.logger.error('Failed to fetch job for workflow advance:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to advance workflow step',
      });
    }
    if (!row || row.tenant_id !== user.tenantId) {
      throw new NotFoundException({
        error_code: ErrorCode.RESOURCE_NOT_FOUND,
        message: 'Job not found',
      });
    }

    // 2) Ownership gate — a technician may only advance jobs assigned to them.
    //    Resolved AFTER the 404 so a cross-tenant job is never disclosed as 403.
    if (row.technician_id !== user.userId) {
      throw new ForbiddenException({
        error_code: ErrorCode.FORBIDDEN,
        message: 'Forbidden',
      });
    }

    // 3) Terminal-status guard (friendly 409; the RPC re-guards under FOR UPDATE).
    if (
      row.status !== JobStatus.SCHEDULED &&
      row.status !== JobStatus.IN_PROGRESS
    ) {
      throw new HttpException(
        {
          error_code: ErrorCode.JOB_NOT_MODIFIABLE,
          message: 'Job is not modifiable in its current status',
        },
        HttpStatus.CONFLICT,
      );
    }

    // 3.5) Same-step no-op: if the step is already recorded server-side, return
    //      current state without re-applying (AC1 — offline replay dedup without
    //      idempotency key). Re-fetch full row so toResponse() has all columns.
    if (row.current_step === dto.step) {
      const { data: fullRow, error: fullRowError } = await admin
        .from('jobs')
        .select('*')
        .eq('id', jobId)
        .eq('tenant_id', user.tenantId)
        .single<JobRow>();

      if (fullRowError || !fullRow) {
        throw new NotFoundException({
          error_code: ErrorCode.RESOURCE_NOT_FOUND,
          message: 'Job not found',
        });
      }

      return this.jobsService.toResponse(fullRow);
    }

    // 4) Step-ordering validation. An out-of-order/backward/illegal-skip step →
    //    422 INVALID_WORKFLOW_STEP, carrying the current step in the body
    //    (forwarded by GlobalExceptionFilter).
    if (
      !this.validateStep(
        row.current_step,
        dto.step,
        row.require_completion_photo,
      )
    ) {
      throw new HttpException(
        {
          error_code: ErrorCode.INVALID_WORKFLOW_STEP,
          message: 'Invalid workflow step transition',
          currentStep: row.current_step,
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // 5) Target status: on_my_way starts the job, completed finishes it; every
    //    other step leaves status unchanged (null → COALESCE keeps it).
    const newStatus =
      dto.step === WorkflowStep.ON_MY_WAY
        ? JobStatus.IN_PROGRESS
        : dto.step === WorkflowStep.COMPLETED
          ? JobStatus.COMPLETED
          : null;

    // 6) Atomic step advance + activity log (AR-10). The compare-and-set on
    //    p_expected_current_step closes the TOCTOU window inside the RPC.
    const { data, error: rpcError } = await admin.rpc('advance_workflow_step', {
      p_job_id: jobId,
      p_tenant_id: user.tenantId,
      p_actor_id: user.userId,
      p_step: dto.step,
      p_new_status: newStatus,
      p_expected_current_step: row.current_step,
    });

    if (rpcError) {
      const code = (rpcError as { code?: string }).code;
      // PT409: terminal status raced in, or a concurrent advance changed
      // current_step between our read and the RPC's FOR UPDATE (verified live
      // via MCP — same PostgREST contract as update_job_with_log).
      if (code === 'PT409') {
        throw new HttpException(
          {
            error_code: ErrorCode.JOB_NOT_MODIFIABLE,
            message: 'Job is not modifiable in its current status',
          },
          HttpStatus.CONFLICT,
        );
      }
      this.logger.error('advance_workflow_step RPC failed:', { rpcError });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to advance workflow step',
      });
    }

    // RETURNS SETOF jobs ⇒ an empty array means the job vanished between the
    // fetch and the RPC (missing/cross-tenant) → 404.
    const rows = data as JobRow[] | null;
    if (!rows || rows.length === 0) {
      throw new NotFoundException({
        error_code: ErrorCode.RESOURCE_NOT_FOUND,
        message: 'Job not found',
      });
    }

    return this.jobsService.toResponse(rows[0]);
  }
}
