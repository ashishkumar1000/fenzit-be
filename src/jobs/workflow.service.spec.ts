import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { WorkflowService } from './workflow.service';
import { JobsService } from './jobs.service';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import { AdvanceWorkflowDto } from './dto/advance-workflow.dto';
import { WorkflowStep } from './enums/workflow-step.enum';
import { ErrorCode } from '../common/enums/error-code.enum';

describe('WorkflowService', () => {
  let service: WorkflowService;
  let supabaseClientFactory: jest.Mocked<SupabaseClientFactory>;
  let jobsService: { toResponse: jest.Mock };

  const tech: RequestUser = {
    userId: 'tech-1',
    tenantId: 'tenant-uuid',
    role: Role.TECHNICIAN,
    rawJwt: 'jwt',
  };
  const techNoTenant: RequestUser = { ...tech, tenantId: null };

  // Job assigned to tech-1, scheduled, no step yet.
  const baseJobRow = {
    id: 'job-uuid',
    tenant_id: 'tenant-uuid',
    status: 'scheduled',
    current_step: null as string | null,
    require_completion_photo: false,
    technician_id: 'tech-1',
  };

  // The full RETURNS SETOF jobs row the RPC returns.
  const fullJobRow = {
    id: 'job-uuid',
    job_number: 'JB-2026-0001',
    tenant_id: 'tenant-uuid',
    customer_id: 'cust-1',
    technician_id: 'tech-1',
    service_location: 'Loc',
    service_type: 'ac_service',
    scheduled_start: '2026-06-22T09:30:00Z',
    scheduled_end: null,
    status: 'in_progress',
    current_step: 'on_my_way',
    priority: 'normal',
    require_completion_photo: false,
    description: null,
    notes_for_technician: null,
    created_at: '2026-06-21T00:00:00Z',
    updated_at: '2026-06-21T00:05:00Z',
  };

  const dto = (step: WorkflowStep): AdvanceWorkflowDto => ({ step });

  beforeEach(async () => {
    const mockFactory = { create: jest.fn(), createAdmin: jest.fn() };
    jobsService = { toResponse: jest.fn((row) => ({ mapped: true, row })) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkflowService,
        { provide: SupabaseClientFactory, useValue: mockFactory },
        { provide: JobsService, useValue: jobsService },
      ],
    }).compile();

    service = module.get<WorkflowService>(WorkflowService);
    supabaseClientFactory = module.get(SupabaseClientFactory);
  });

  // select().eq().eq().single() chain returning the job-fetch result.
  function jobFetchChain(result: { data: unknown; error: unknown }) {
    const single = jest.fn().mockResolvedValue(result);
    const eq2 = jest.fn().mockReturnValue({ single });
    const eq1 = jest.fn().mockReturnValue({ eq: eq2 });
    const select = jest.fn().mockReturnValue({ eq: eq1 });
    return { select };
  }

  function mockAdmin(opts: {
    job?: { data: unknown; error: unknown };
    rpc?: { data: unknown; error: unknown };
  }) {
    const rpc = jest
      .fn()
      .mockResolvedValue(opts.rpc ?? { data: [fullJobRow], error: null });
    const from = jest.fn((table: string) => {
      if (table === 'jobs')
        return jobFetchChain(opts.job ?? { data: baseJobRow, error: null });
      throw new Error(`unexpected table ${table}`);
    });
    supabaseClientFactory.createAdmin.mockReturnValue({ from, rpc } as never);
    return { from, rpc };
  }

  describe('validateStep', () => {
    it.each([
      [null, WorkflowStep.ON_MY_WAY, false, true],
      ['on_my_way', WorkflowStep.ARRIVED, false, true],
      ['arrived', WorkflowStep.IN_PROGRESS, false, true],
      ['in_progress', WorkflowStep.PHOTOS_UPLOADED, false, true],
      ['in_progress', WorkflowStep.SIGNATURE_CAPTURED, false, true], // skip photos
      ['in_progress', WorkflowStep.SIGNATURE_CAPTURED, true, false], // photo required
      ['photos_uploaded', WorkflowStep.SIGNATURE_CAPTURED, true, true],
      ['signature_captured', WorkflowStep.COMPLETED, false, true],
      ['on_my_way', WorkflowStep.COMPLETED, false, false], // out of order
      ['in_progress', WorkflowStep.ON_MY_WAY, false, false], // backward
      ['on_my_way', WorkflowStep.ON_MY_WAY, false, false], // same step
      [null, WorkflowStep.ARRIVED, false, false], // can't skip on_my_way
      ['garbage', WorkflowStep.ON_MY_WAY, false, false], // corrupt current_step ≠ fresh job
      ['garbage', WorkflowStep.ARRIVED, false, false], // corrupt current_step is not advanceable
    ])(
      'current=%s requested=%s photo=%s → %s',
      (current, requested, photo, expected) => {
        expect(service.validateStep(current, requested, photo)).toBe(expected);
      },
    );
  });

  describe('advanceWorkflowStep', () => {
    it('advances on_my_way → 200; rpc gets p_new_status in_progress, expected null', async () => {
      const { rpc } = mockAdmin({});
      const res = await service.advanceWorkflowStep(
        tech,
        'job-uuid',
        dto(WorkflowStep.ON_MY_WAY),
      );

      expect(rpc).toHaveBeenCalledWith(
        'advance_workflow_step',
        expect.objectContaining({
          p_job_id: 'job-uuid',
          p_tenant_id: 'tenant-uuid',
          p_actor_id: 'tech-1',
          p_step: 'on_my_way',
          p_new_status: 'in_progress',
          p_expected_current_step: null,
        }),
      );
      expect(jobsService.toResponse).toHaveBeenCalledWith(fullJobRow);
      expect(res).toEqual({ mapped: true, row: fullJobRow });
    });

    it('completed step → rpc gets p_new_status completed', async () => {
      const { rpc } = mockAdmin({
        job: {
          data: {
            ...baseJobRow,
            status: 'in_progress',
            current_step: 'signature_captured',
          },
          error: null,
        },
      });
      await service.advanceWorkflowStep(
        tech,
        'job-uuid',
        dto(WorkflowStep.COMPLETED),
      );
      expect(rpc).toHaveBeenCalledWith(
        'advance_workflow_step',
        expect.objectContaining({ p_new_status: 'completed' }),
      );
    });

    it('mid step (arrived) → rpc gets p_new_status null', async () => {
      const { rpc } = mockAdmin({
        job: {
          data: {
            ...baseJobRow,
            status: 'in_progress',
            current_step: 'on_my_way',
          },
          error: null,
        },
      });
      await service.advanceWorkflowStep(
        tech,
        'job-uuid',
        dto(WorkflowStep.ARRIVED),
      );
      expect(rpc).toHaveBeenCalledWith(
        'advance_workflow_step',
        expect.objectContaining({ p_new_status: null }),
      );
    });

    it('out-of-order step → 422 INVALID_WORKFLOW_STEP with currentStep; rpc NOT called', async () => {
      const { rpc } = mockAdmin({
        job: {
          data: {
            ...baseJobRow,
            status: 'in_progress',
            current_step: 'on_my_way',
          },
          error: null,
        },
      });
      await expect(
        service.advanceWorkflowStep(
          tech,
          'job-uuid',
          dto(WorkflowStep.COMPLETED),
        ),
      ).rejects.toMatchObject({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        response: {
          error_code: ErrorCode.INVALID_WORKFLOW_STEP,
          currentStep: 'on_my_way',
        },
      });
      expect(rpc).not.toHaveBeenCalled();
    });

    it('skip photos when require_completion_photo=true → 422; rpc NOT called', async () => {
      const { rpc } = mockAdmin({
        job: {
          data: {
            ...baseJobRow,
            status: 'in_progress',
            current_step: 'in_progress',
            require_completion_photo: true,
          },
          error: null,
        },
      });
      await expect(
        service.advanceWorkflowStep(
          tech,
          'job-uuid',
          dto(WorkflowStep.SIGNATURE_CAPTURED),
        ),
      ).rejects.toBeInstanceOf(HttpException);
      expect(rpc).not.toHaveBeenCalled();
    });

    it('technician not the assignee → 403 FORBIDDEN', async () => {
      mockAdmin({
        job: {
          data: { ...baseJobRow, technician_id: 'other-tech' },
          error: null,
        },
      });
      await expect(
        service.advanceWorkflowStep(
          tech,
          'job-uuid',
          dto(WorkflowStep.ON_MY_WAY),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('job not found (PGRST116) → 404', async () => {
      mockAdmin({ job: { data: null, error: { code: 'PGRST116' } } });
      await expect(
        service.advanceWorkflowStep(
          tech,
          'job-uuid',
          dto(WorkflowStep.ON_MY_WAY),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('real DB error on fetch → 500', async () => {
      mockAdmin({ job: { data: null, error: { code: '08006' } } });
      await expect(
        service.advanceWorkflowStep(
          tech,
          'job-uuid',
          dto(WorkflowStep.ON_MY_WAY),
        ),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });

    it('no tenant → 400 VALIDATION_ERROR', async () => {
      await expect(
        service.advanceWorkflowStep(
          techNoTenant,
          'job-uuid',
          dto(WorkflowStep.ON_MY_WAY),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('terminal status (completed) → 409 JOB_NOT_MODIFIABLE; rpc NOT called', async () => {
      const { rpc } = mockAdmin({
        job: {
          data: {
            ...baseJobRow,
            status: 'completed',
            current_step: 'completed',
          },
          error: null,
        },
      });
      await expect(
        service.advanceWorkflowStep(
          tech,
          'job-uuid',
          dto(WorkflowStep.ON_MY_WAY),
        ),
      ).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
      expect(rpc).not.toHaveBeenCalled();
    });

    it('RPC raises PT409 → 409 JOB_NOT_MODIFIABLE', async () => {
      mockAdmin({ rpc: { data: null, error: { code: 'PT409' } } });
      await expect(
        service.advanceWorkflowStep(
          tech,
          'job-uuid',
          dto(WorkflowStep.ON_MY_WAY),
        ),
      ).rejects.toMatchObject({
        status: HttpStatus.CONFLICT,
        response: { error_code: ErrorCode.JOB_NOT_MODIFIABLE },
      });
    });

    it('RPC returns empty set → 404', async () => {
      mockAdmin({ rpc: { data: [], error: null } });
      await expect(
        service.advanceWorkflowStep(
          tech,
          'job-uuid',
          dto(WorkflowStep.ON_MY_WAY),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('RPC unknown error → 500', async () => {
      mockAdmin({ rpc: { data: null, error: { code: 'XX000' } } });
      await expect(
        service.advanceWorkflowStep(
          tech,
          'job-uuid',
          dto(WorkflowStep.ON_MY_WAY),
        ),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });
  });
});
