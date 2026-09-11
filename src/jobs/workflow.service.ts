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
import { JobsService, JobResponse, JobRow, JOB_COLUMNS } from './jobs.service';
import { AdvanceWorkflowDto } from './dto/advance-workflow.dto';
import { JobStatus } from './enums/job-status.enum';
import {
  parseTemplateSteps,
  nextStepKey,
  setsStatusOf,
  TemplateStep,
} from './workflow-template.model';

/** Columns needed to gate + advance the workflow, plus the stamped template's
 *  steps (embedded via the workflow_template_id FK — the stamp's id uniquely
 *  identifies the template row). */
interface WorkflowJobRow {
  id: string;
  tenant_id: string;
  status: JobStatus;
  current_step: string | null;
  workflow_template_version: number;
  technician_id: string;
  workflow_templates: { version: number; steps: unknown } | null;
}

@Injectable()
export class WorkflowService {
  private readonly logger = new Logger(WorkflowService.name);

  constructor(
    private readonly supabaseClientFactory: SupabaseClientFactory,
    private readonly jobsService: JobsService,
  ) {}

  /**
   * Pure step-ordering rule (Story 4.4, template-driven).
   *
   * The requested step must be the FIRST not-yet-completed step in the job's
   * stamped template order — no skipping, no flag-driven chain filtering; the
   * template's ordered steps ARE the chain (requires_photo / requires_signature
   * are frontend action gates, not chain filters). A fresh job (current_step
   * null) advances to the template's first step; a corrupt current_step (non-
   * null but absent from the template) yields no legal target, so every
   * advance is rejected and the workflow is never silently reset.
   */
  validateStep(
    steps: TemplateStep[],
    currentStep: string | null,
    requested: string,
  ): boolean {
    return requested === nextStepKey(steps, currentStep);
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
        'id, tenant_id, status, current_step, workflow_template_version, technician_id, workflow_templates(version, steps)',
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
    //      idempotency key). Re-fetch full row (with the skill/template embeds —
    //      Story 4.5) so toResponse() has all columns.
    if (row.current_step === dto.step) {
      const { data: fullRow, error: fullRowError } = await admin
        .from('jobs')
        .select(JOB_COLUMNS)
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

    // 4) Parse the stamped template's steps. The stamp (id, version) uniquely
    //    identifies the template row; a version mismatch means the stamp was
    //    written by a buggy path — treat as corrupt data, reject the advance.
    const stamp = row.workflow_templates;
    const steps =
      stamp && stamp.version === row.workflow_template_version
        ? parseTemplateSteps(stamp.steps)
        : null;

    if (!steps) {
      this.logger.error('Job carries an unreadable workflow template stamp:', {
        jobId,
        workflow_template_version: row.workflow_template_version,
      });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to advance workflow step',
      });
    }

    // 5) Step-ordering validation. An out-of-order/backward/illegal-skip step —
    //    or a corrupt current_step — → 422 INVALID_WORKFLOW_STEP, carrying the
    //    current step in the body (forwarded by GlobalExceptionFilter).
    if (!this.validateStep(steps, row.current_step, dto.step)) {
      throw new HttpException(
        {
          error_code: ErrorCode.INVALID_WORKFLOW_STEP,
          message: 'Invalid workflow step transition',
          currentStep: row.current_step,
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // 6) Target status is step data: the target step's sets_status ('in_progress'
    //    starts the job, 'completed' finishes it — the RPC stamps completed_at;
    //    null → COALESCE keeps the current status).
    const rawSetsStatus = setsStatusOf(steps, dto.step);
    const newStatus =
      rawSetsStatus === 'in_progress'
        ? JobStatus.IN_PROGRESS
        : rawSetsStatus === 'completed'
          ? JobStatus.COMPLETED
          : null;

    // 7) Atomic step advance + activity log (AR-10). The compare-and-set on
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

    return this.jobsService.toResponse(
      // The RPC returns bare job rows; re-fetch with the skill/template embeds
      // so the advance response carries the full read shape (Story 4.5). The
      // response keeps the RPC's row as fallback if the re-fetch fails.
      await this.jobsService.refetchWithEmbeds(
        admin,
        jobId,
        user.tenantId,
        rows[0],
      ),
    );
  }
}
