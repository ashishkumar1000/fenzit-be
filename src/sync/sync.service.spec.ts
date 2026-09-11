import { SyncService } from './sync.service';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { Role } from '../common/enums/role.enum';
import { RequestUser } from '../common/interfaces/request-user.interface';
import {
  parseTemplateSteps,
  stepToResponse,
  TemplateStep,
} from '../jobs/workflow-template.model';

// The v1 seed chain (migration 20260911000002). src/ unit specs keep their own
// inline copy — the shared copy lives at test/fixtures/v1-template.ts.
const V1_STEPS: unknown = [
  {
    key: 'on_my_way',
    label: 'On My Way',
    requires_photo: false,
    requires_signature: false,
    sets_status: 'in_progress',
    advances_on: null,
  },
  {
    key: 'arrived',
    label: 'Arrived',
    requires_photo: false,
    requires_signature: false,
    sets_status: null,
    advances_on: null,
  },
  {
    key: 'in_progress',
    label: 'In Progress',
    requires_photo: false,
    requires_signature: false,
    sets_status: null,
    advances_on: null,
  },
  {
    key: 'photos_uploaded',
    label: 'Photos Uploaded',
    requires_photo: true,
    requires_signature: false,
    sets_status: null,
    advances_on: 'photo_confirm',
  },
  {
    key: 'signature_captured',
    label: 'Signature Captured',
    requires_photo: false,
    requires_signature: true,
    sets_status: null,
    advances_on: null,
  },
  {
    key: 'completed',
    label: 'Completed',
    requires_photo: false,
    requires_signature: false,
    sets_status: 'completed',
    advances_on: null,
  },
];

const V1_STEPS_RESPONSE = (parseTemplateSteps(V1_STEPS) as TemplateStep[]).map(
  stepToResponse,
);

describe('SyncService', () => {
  const user: RequestUser = {
    userId: 'tech-1',
    tenantId: 'tenant-1',
    role: Role.TECHNICIAN,
    rawJwt: 'raw-jwt',
  };

  function buildChain(data: any[], error: any = null) {
    const chain: any = {};
    for (const method of ['select', 'eq', 'gt', 'order']) {
      chain[method] = jest.fn().mockReturnValue(chain);
    }
    chain.limit = jest.fn().mockResolvedValue({ data, error });
    return chain;
  }

  function mockFactory(chain: any) {
    const create = jest.fn().mockReturnValue({ from: () => chain });
    const service = new SyncService({
      create,
    } as unknown as SupabaseClientFactory);
    return { service, create };
  }

  it('maps current_step, customer and attachment fields onto the sync payload', async () => {
    // Values deliberately non-default: dropping any of these from the select
    // string or the mapper would serialize undefined and fail this pin. The
    // Story 4.4 flags are gone — the stamped template drives photo/signature
    // behaviour, so the payload carries only the step pointer.
    const chain = buildChain([
      {
        id: 'job-1',
        job_number: 'JB-2026-0001',
        tenant_id: 'tenant-1',
        customer_id: 'cust-1',
        technician_id: 'tech-1',
        service_location: 'Ranchi',
        scheduled_start: '2026-06-22T09:30:00Z',
        scheduled_end: '2026-06-22T10:30:00Z',
        status: 'in_progress',
        current_step: 'in_progress',
        priority: 'urgent',
        description: 'Leaky AC',
        notes_for_technician: 'Bring ladder',
        created_at: '2026-06-21T00:00:00Z',
        updated_at: '2026-06-22T08:00:00Z',
        customers: { name: 'Ravi Kumar', address: '12 MG Road' },
        attachments: [
          {
            id: 'att-1',
            attachment_type: 'photo',
            size_bytes: 1024,
            created_at: '2026-06-22T08:01:00Z',
          },
        ],
        // Story 4.5 — skill/template embeds on the sync payload.
        skills: { id: 'skill-uuid-1', name: 'AC Repair' },
        workflow_templates: { version: 1, steps: V1_STEPS },
      },
    ]);
    const { service } = mockFactory(chain);

    const result = await service.sync(user);

    expect(result.jobs).toHaveLength(1);
    const job = result.jobs[0] as any;
    expect(job.currentStep).toBe('in_progress');
    expect(job.priority).toBe('urgent');
    expect(job.scheduledEnd).toBe('2026-06-22T10:30:00Z');
    expect(job.notesForTechnician).toBe('Bring ladder');
    expect(job.customer).toEqual({ name: 'Ravi Kumar', address: '12 MG Road' });
    expect(job.attachments).toEqual([
      {
        id: 'att-1',
        attachmentType: 'photo',
        sizeBytes: 1024,
        createdAt: '2026-06-22T08:01:00Z',
      },
    ]);
    // Story 4.5 — the sync payload carries the same skill/template shape the
    // job responses do (current_step 'in_progress' = steps[2], 0-based).
    expect(job.skill).toEqual({ id: 'skill-uuid-1', name: 'AC Repair' });
    expect(job.workflowTemplate).toEqual({
      version: 1,
      steps: V1_STEPS_RESPONSE,
    });
    expect(job.currentStepIndex).toBe(2);
    // Story 4.4 — flag fields no longer exist on the payload.
    expect(job).not.toHaveProperty('requireCompletionPhoto');
    expect(job).not.toHaveProperty('requireCompletionSignature');
  });

  it('maps a fresh job (no embeds selected / null embeds) to null skill fields, never a throw', async () => {
    const chain = buildChain([
      {
        id: 'job-2',
        job_number: 'JB-2026-0002',
        tenant_id: 'tenant-1',
        customer_id: 'cust-1',
        technician_id: 'tech-1',
        service_location: 'Ranchi',
        scheduled_start: '2026-06-22T09:30:00Z',
        scheduled_end: null,
        status: 'scheduled',
        current_step: null,
        priority: 'normal',
        description: null,
        notes_for_technician: null,
        created_at: '2026-06-21T00:00:00Z',
        updated_at: '2026-06-22T08:00:00Z',
        customers: { name: 'Ravi Kumar', address: null },
        attachments: [],
        skills: null,
        workflow_templates: null,
      },
    ]);
    const { service } = mockFactory(chain);

    const result = await service.sync(user);

    const job = result.jobs[0] as any;
    expect(job.skill).toBeNull();
    expect(job.workflowTemplate).toBeNull();
    // Fresh job — null index, not 0.
    expect(job.currentStepIndex).toBeNull();
  });

  it('scopes the delta query to the caller tenant + technician and applies gt filter', async () => {
    const chain = buildChain([]);
    const { service, create } = mockFactory(chain);

    await service.sync(user, '2026-06-21T09:00:00Z');

    expect(create).toHaveBeenCalledWith('raw-jwt');
    expect(chain.eq).toHaveBeenCalledWith('tenant_id', 'tenant-1');
    expect(chain.eq).toHaveBeenCalledWith('technician_id', 'tech-1');
    expect(chain.gt).toHaveBeenCalledWith('updated_at', '2026-06-21T09:00:00Z');
    // Terminal operator + page cap — the await must resolve at .limit(500).
    expect(chain.limit).toHaveBeenCalledWith(500);
  });

  it('selects the shared JOB_COLUMNS plus the sync-only relation embeds (Story 4.5)', async () => {
    // Pins the select string: the sync payload is composed from the exported
    // JOB_COLUMNS (so a future job column cannot silently miss this payload)
    // plus the customers/attachments embeds only sync needs. The same
    // assertion guards list/detail/profile in the jobs/users specs.
    const chain = buildChain([]);
    const { service } = mockFactory(chain);

    await service.sync(user);

    expect(chain.select).toHaveBeenCalledWith(
      expect.stringContaining(
        'skills(id, name), workflow_templates(version, steps)',
      ),
    );
    expect(chain.select).toHaveBeenCalledWith(
      expect.stringContaining('customers!inner(name, address)'),
    );
    expect(chain.select).toHaveBeenCalledWith(
      expect.stringContaining(
        'attachments(id, attachment_type, size_bytes, created_at)',
      ),
    );
    // Every sync payload field must come from the select — the mapping reads
    // these columns directly, so a dropped column serializes undefined.
    for (const column of [
      'current_step',
      'priority',
      'notes_for_technician',
      'scheduled_end',
    ]) {
      expect(chain.select).toHaveBeenCalledWith(
        expect.stringContaining(column),
      );
    }
  });

  it('throws 500 InternalServerErrorException when the sync query fails', async () => {
    const chain = buildChain([], { message: 'db down' });
    const { service } = mockFactory(chain);

    await expect(service.sync(user)).rejects.toMatchObject({
      status: 500,
      message: 'Sync query failed',
    });
  });
});
