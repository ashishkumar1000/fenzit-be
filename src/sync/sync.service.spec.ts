import { SyncService } from './sync.service';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { Role } from '../common/enums/role.enum';
import { RequestUser } from '../common/interfaces/request-user.interface';

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
    // Story 4.4 — flag fields no longer exist on the payload.
    expect(job).not.toHaveProperty('requireCompletionPhoto');
    expect(job).not.toHaveProperty('requireCompletionSignature');
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

  it('throws 500 InternalServerErrorException when the sync query fails', async () => {
    const chain = buildChain([], { message: 'db down' });
    const { service } = mockFactory(chain);

    await expect(service.sync(user)).rejects.toMatchObject({
      status: 500,
      message: 'Sync query failed',
    });
  });
});
