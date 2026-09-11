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
import { ErrorCode } from '../common/enums/error-code.enum';
import {
  parseTemplateSteps,
  nextStepKey,
  photoConfirmStep,
  setsStatusOf,
  TemplateStep,
} from './workflow-template.model';

// The v1 seed chain (migration 20260911000002) — 6 identical steps per skill.
const V1_STEPS: unknown = [
  { key: 'on_my_way', label: 'On My Way', requires_photo: false, requires_signature: false, sets_status: 'in_progress', advances_on: null },
  { key: 'arrived', label: 'Arrived', requires_photo: false, requires_signature: false, sets_status: null, advances_on: null },
  { key: 'in_progress', label: 'In Progress', requires_photo: false, requires_signature: false, sets_status: null, advances_on: null },
  { key: 'photos_uploaded', label: 'Photos Uploaded', requires_photo: true, requires_signature: false, sets_status: null, advances_on: 'photo_confirm' },
  { key: 'signature_captured', label: 'Signature Captured', requires_photo: false, requires_signature: true, sets_status: null, advances_on: null },
  { key: 'completed', label: 'Completed', requires_photo: false, requires_signature: false, sets_status: 'completed', advances_on: null },
];

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

  // Job assigned to tech-1, scheduled, no step yet, stamped with the v1 seed
  // template (id fixed by the seed migration; the FK embed resolves by id).
  const baseJobRow = {
    id: 'job-uuid',
    tenant_id: 'tenant-uuid',
    status: 'scheduled',
    current_step: null as string | null,
    workflow_template_version: 1,
    technician_id: 'tech-1',
    workflow_templates: { version: 1, steps: V1_STEPS },
  };

  // The full RETURNS SETOF jobs row the RPC returns.
  const fullJobRow = {
    id: 'job-uuid',
    job_number: 'JB-2026-0001',
    tenant_id: 'tenant-uuid',
    customer_id: 'cust-1',
    technician_id: 'tech-1',
    service_location: 'Loc',
    scheduled_start: '2026-06-22T09:30:00Z',
    scheduled_end: null,
    status: 'in_progress',
    current_step: 'on_my_way',
    priority: 'normal',
    description: null,
    notes_for_technician: null,
    created_at: '2026-06-21T00:00:00Z',
    updated_at: '2026-06-21T00:05:00Z',
  };

  const dto = (step: string): AdvanceWorkflowDto => ({ step });

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

  const v1Steps = parseTemplateSteps(V1_STEPS) as TemplateStep[];

  describe('workflow-template.model', () => {
    it('parses the v1 seed chain', () => {
      expect(v1Steps).toHaveLength(6);
      expect(v1Steps.map((s) => s.key)).toEqual([
        'on_my_way',
        'arrived',
        'in_progress',
        'photos_uploaded',
        'signature_captured',
        'completed',
      ]);
    });

    it.each([
      // [steps, current, requested, expected]
      [V1_STEPS, null, 'on_my_way', true],
      [V1_STEPS, 'on_my_way', 'arrived', true],
      [V1_STEPS, 'in_progress', 'photos_uploaded', true],
      [V1_STEPS, 'photos_uploaded', 'signature_captured', true],
      [V1_STEPS, 'signature_captured', 'completed', true],
      // No skipping — the template's ordered steps ARE the chain.
      [V1_STEPS, 'in_progress', 'signature_captured', false],
      [V1_STEPS, 'in_progress', 'completed', false],
      [V1_STEPS, 'on_my_way', 'completed', false],
      [V1_STEPS, 'in_progress', 'on_my_way', false],
      [V1_STEPS, 'completed', 'completed', false],
      // Fresh job can't skip the first step.
      [V1_STEPS, null, 'arrived', false],
      // Corrupt current_step rejects every advance.
      [V1_STEPS, 'garbage', 'on_my_way', false],
      [V1_STEPS, 'garbage', 'completed', false],
    ])(
      'nextStepKey(v1, %j) === %j → %s',
      (steps, current, requested, expected) => {
        expect(service.validateStep(v1Steps, current, requested)).toBe(expected);
      },
    );

    it('corrupt template shapes are rejected by the parser', () => {
      expect(parseTemplateSteps([])).toBeNull();
      expect(parseTemplateSteps('nope')).toBeNull();
      expect(parseTemplateSteps([{ key: 'a', label: 'A', requires_photo: 'x', requires_signature: false }])).toBeNull();
      expect(parseTemplateSteps([{ key: 'Bad Key', label: 'A', requires_photo: false, requires_signature: false }])).toBeNull();
      expect(parseTemplateSteps([{ key: 'a', label: '', requires_photo: false, requires_signature: false }])).toBeNull();
      expect(parseTemplateSteps([{ key: 'a', label: 'A', requires_photo: false, requires_signature: false, sets_status: 'scheduled' }])).toBeNull();
      expect(parseTemplateSteps([{ key: 'a', label: 'A', requires_photo: false, requires_signature: false, advances_on: 'magic' }])).toBeNull();
      expect(
        parseTemplateSteps([
          { key: 'a', label: 'A', requires_photo: false, requires_signature: false },
          { key: 'a', label: 'B', requires_photo: false, requires_signature: false },
        ]),
      ).toBeNull();
    });

    it('valid custom chains parse; sets_status and photo_confirm lookups work', () => {
      const custom = parseTemplateSteps([
        { key: 's1', label: 'S1', requires_photo: false, requires_signature: false, sets_status: 'in_progress' },
        { key: 's2', label: 'S2', requires_photo: true, requires_signature: true, sets_status: null, advances_on: 'photo_confirm' },
      ]);
      expect(custom).toHaveLength(2);
      expect(nextStepKey(custom as TemplateStep[], null)).toBe('s1');
      expect(nextStepKey(custom as TemplateStep[], 's1')).toBe('s2');
      expect(nextStepKey(custom as TemplateStep[], 's2')).toBeNull(); // chain exhausted
      expect(setsStatusOf(custom as TemplateStep[], 's1')).toBe('in_progress');
      expect(setsStatusOf(custom as TemplateStep[], 's2')).toBeNull();
      expect(photoConfirmStep(custom as TemplateStep[])?.key).toBe('s2');
      // Absent/null attributes normalise to null.
      const noAttrs = parseTemplateSteps([
        { key: 'a', label: 'A', requires_photo: false, requires_signature: false },
      ]);
      expect(setsStatusOf(noAttrs as TemplateStep[], 'a')).toBeNull();
      expect(photoConfirmStep(noAttrs as TemplateStep[])).toBeNull();
    });

    it('chain exhausted → no legal target (null)', () => {
      expect(nextStepKey(v1Steps, 'completed')).toBeNull();
    });
  });

  describe('advanceWorkflowStep', () => {
    it('advances on_my_way → 200; rpc gets p_new_status in_progress, expected null', async () => {
      const { rpc } = mockAdmin({});
      const res = await service.advanceWorkflowStep(
        tech,
        'job-uuid',
        dto('on_my_way'),
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

    it('completed step → rpc gets p_new_status completed (sets_status step data)', async () => {
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
        dto('completed'),
      );
      expect(rpc).toHaveBeenCalledWith(
        'advance_workflow_step',
        expect.objectContaining({ p_new_status: 'completed' }),
      );
    });

    it('mid step (arrived) → rpc gets p_new_status null (intermediate keeps status)', async () => {
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
        dto('arrived'),
      );
      expect(rpc).toHaveBeenCalledWith(
        'advance_workflow_step',
        expect.objectContaining({ p_new_status: null }),
      );
    });

    it('non-v1 template: a custom chain drives status and order', async () => {
      const custom = [
        { key: 's1', label: 'S1', requires_photo: false, requires_signature: false, sets_status: 'in_progress' },
        { key: 's2', label: 'S2', requires_photo: true, requires_signature: true, sets_status: 'completed' },
      ];
      const { rpc } = mockAdmin({
        job: {
          data: {
            ...baseJobRow,
            current_step: 's1',
            workflow_templates: { version: 1, steps: custom },
          },
          error: null,
        },
      });
      await service.advanceWorkflowStep(tech, 'job-uuid', dto('s2'));
      expect(rpc).toHaveBeenCalledWith(
        'advance_workflow_step',
        expect.objectContaining({ p_step: 's2', p_new_status: 'completed' }),
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
          dto('completed'),
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

    it('skipping a step → 422; rpc NOT called (no flag-driven chain filtering)', async () => {
      const { rpc } = mockAdmin({
        job: {
          data: {
            ...baseJobRow,
            status: 'in_progress',
            current_step: 'in_progress',
          },
          error: null,
        },
      });
      // The template's next step is photos_uploaded; jumping to signature_captured
      // is illegal regardless of any job-level flag (flags no longer exist).
      await expect(
        service.advanceWorkflowStep(
          tech,
          'job-uuid',
          dto('signature_captured'),
        ),
      ).rejects.toMatchObject({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        response: {
          error_code: ErrorCode.INVALID_WORKFLOW_STEP,
          currentStep: 'in_progress',
        },
      });
      expect(rpc).not.toHaveBeenCalled();
    });

    it('corrupt current_step → 422 echoing it; rpc NOT called (never resets)', async () => {
      const { rpc } = mockAdmin({
        job: {
          data: {
            ...baseJobRow,
            status: 'in_progress',
            current_step: 'garbage',
          },
          error: null,
        },
      });
      await expect(
        service.advanceWorkflowStep(tech, 'job-uuid', dto('on_my_way')),
      ).rejects.toMatchObject({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        response: {
          error_code: ErrorCode.INVALID_WORKFLOW_STEP,
          currentStep: 'garbage',
        },
      });
      expect(rpc).not.toHaveBeenCalled();
    });

    it('unreadable template stamp (malformed steps) → 500; rpc NOT called', async () => {
      const { rpc } = mockAdmin({
        job: {
          data: {
            ...baseJobRow,
            workflow_templates: { version: 1, steps: [{ bogus: true }] },
          },
          error: null,
        },
      });
      await expect(
        service.advanceWorkflowStep(tech, 'job-uuid', dto('on_my_way')),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
      expect(rpc).not.toHaveBeenCalled();
    });

    it('template stamp version mismatch → 500; rpc NOT called', async () => {
      const { rpc } = mockAdmin({
        job: {
          data: {
            ...baseJobRow,
            workflow_template_version: 2,
          },
          error: null,
        },
      });
      await expect(
        service.advanceWorkflowStep(tech, 'job-uuid', dto('on_my_way')),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
      expect(rpc).not.toHaveBeenCalled();
    });

    it('missing template embed → 500; rpc NOT called', async () => {
      const { rpc } = mockAdmin({
        job: {
          data: { ...baseJobRow, workflow_templates: null },
          error: null,
        },
      });
      await expect(
        service.advanceWorkflowStep(tech, 'job-uuid', dto('on_my_way')),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
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
          dto('on_my_way'),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('job not found (PGRST116) → 404', async () => {
      mockAdmin({ job: { data: null, error: { code: 'PGRST116' } } });
      await expect(
        service.advanceWorkflowStep(
          tech,
          'job-uuid',
          dto('on_my_way'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('real DB error on fetch → 500', async () => {
      mockAdmin({ job: { data: null, error: { code: '08006' } } });
      await expect(
        service.advanceWorkflowStep(
          tech,
          'job-uuid',
          dto('on_my_way'),
        ),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });

    it('no tenant → 400 VALIDATION_ERROR', async () => {
      await expect(
        service.advanceWorkflowStep(
          techNoTenant,
          'job-uuid',
          dto('on_my_way'),
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
          dto('on_my_way'),
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
          dto('on_my_way'),
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
          dto('on_my_way'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('RPC unknown error → 500', async () => {
      mockAdmin({ rpc: { data: null, error: { code: 'XX000' } } });
      await expect(
        service.advanceWorkflowStep(
          tech,
          'job-uuid',
          dto('on_my_way'),
        ),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });
  });
});
