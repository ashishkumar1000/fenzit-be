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
    const service = new SyncService({ create } as unknown as SupabaseClientFactory);
    return { service, create };
  }

  it('maps the completion flags onto the sync payload (Story 3.8)', async () => {
    // Values deliberately non-default: dropping either column from the select or
    // the mapper line would serialize undefined and fail this pin.
    const chain = buildChain([
      {
        id: 'job-1',
        job_number: 'JB-2026-0001',
        tenant_id: 'tenant-1',
        customer_id: 'cust-1',
        technician_id: 'tech-1',
        service_location: 'Ranchi',
        service_type: 'ac_service',
        scheduled_start: '2026-06-22T09:30:00Z',
        scheduled_end: null,
        status: 'in_progress',
        current_step: 'in_progress',
        priority: 'normal',
        require_completion_photo: true,
        require_completion_signature: true,
        description: null,
        notes_for_technician: null,
        created_at: '2026-06-21T00:00:00Z',
        updated_at: '2026-06-22T08:00:00Z',
        customers: { name: 'Ravi Kumar', address: '12 MG Road' },
        attachments: [],
      },
    ]);
    const { service } = mockFactory(chain);

    const result = await service.sync(user);

    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].requireCompletionPhoto).toBe(true);
    expect(result.jobs[0].requireCompletionSignature).toBe(true);
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