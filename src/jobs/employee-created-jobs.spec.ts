import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, InternalServerErrorException } from '@nestjs/common';
import { JobsService } from './jobs.service';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { CustomersService } from '../customers/customers.service';
import { StorageService } from '../storage/storage.service';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import { memberRow } from '../../test/helpers/member-rows-stub';
import { CreateJobDto } from './dto/create-job.dto';
import { JobListScope } from './enums/job-list-scope.enum';

/**
 * Employee-created jobs (CAP-2 switch, CAP-3 own jobs only, CAP-4 pending is not
 * assigned work). Covers the createJob employee path end to end in the service,
 * and the list scopes that must hide pending and rejected jobs.
 *
 * Plain English: an employee's job waits for approval when the owner switched
 * that on; a switched-off employee gets a 403 before anything is written.
 */

type Result = { data: unknown; error: unknown };

const employee: RequestUser = {
  userId: 'tech-1',
  tenantId: 'tenant-uuid',
  role: Role.EMPLOYEE,
  platformAdmin: false,
  rawJwt: 'jwt',
};
const owner: RequestUser = {
  userId: 'owner-uuid',
  tenantId: 'tenant-uuid',
  role: Role.COMPANY_ADMIN,
  platformAdmin: false,
  rawJwt: 'jwt',
};

const ownDto: CreateJobDto = {
  customerId: 'cust-1',
  serviceLocation: 'Loc',
  skillId: 'skill-uuid-1',
  scheduledStart: '2099-06-22T09:30:00Z',
  technicianId: 'tech-1',
};

const jobRow = (status: string) => ({
  id: 'job-uuid',
  job_number: 'JB-2026-0001',
  tenant_id: 'tenant-uuid',
  customer_id: 'cust-1',
  technician_id: 'tech-1',
  service_location: 'Loc',
  scheduled_start: '2026-06-22T09:30:00Z',
  scheduled_end: null,
  status,
  completed_at: null,
  current_step: null,
  priority: 'normal',
  description: null,
  notes_for_technician: null,
  created_at: '2026-06-21T00:00:00Z',
  updated_at: '2026-06-21T00:00:00Z',
  skill_id: 'skill-uuid-1',
  skills: null,
  workflow_templates: null,
});

/**
 * A chainable query node. Every filter returns the node; the terminal call
 * (single, maybeSingle, limit, or awaiting the node) resolves to the given result.
 */
function chain(terminal: {
  single?: Result;
  maybeSingle?: Result;
  limit?: Result;
  list?: Result;
}) {
  const node: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'neq', 'not', 'or', 'order', 'gte', 'lt', 'is', 'gt']) {
    node[m] = jest.fn(() => node);
  }
  const none: Result = { data: null, error: null };
  node.single = jest.fn().mockResolvedValue(terminal.single ?? none);
  node.maybeSingle = jest.fn().mockResolvedValue(terminal.maybeSingle ?? none);
  node.limit = jest.fn().mockResolvedValue(terminal.limit ?? { data: [], error: null });
  node.then = (ok: (v: unknown) => unknown, fail: (e: unknown) => unknown) =>
    Promise.resolve(terminal.list ?? { data: [], error: null }).then(ok, fail);
  return node as Record<string, jest.Mock> & { then: unknown };
}

describe('employee-created jobs in JobsService (CAP-2, CAP-3, CAP-4)', () => {
  let service: JobsService;
  let customersService: { findOrCreateByPhone: jest.Mock };
  let factory: { createAdmin: jest.Mock };

  beforeEach(async () => {
    factory = { createAdmin: jest.fn() };
    customersService = { findOrCreateByPhone: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JobsService,
        { provide: SupabaseClientFactory, useValue: factory },
        { provide: CustomersService, useValue: customersService },
        { provide: StorageService, useValue: { presignReadUrl: jest.fn() } },
      ],
    }).compile();
    service = module.get(JobsService);
  });

  /**
   * Wires one admin client. `submission` answers the caller's own switch read
   * (memberships maybeSingle); the same memberships node also answers the company
   * member list the technician check reads, as a member of the company.
   */
  function mockAdmin(opts: { submission?: Result; rpc?: Result } = {}) {
    const memberships = chain({
      maybeSingle: opts.submission ?? {
        data: { can_create_jobs: true, job_approval_required: true },
        error: null,
      },
      list: { data: [memberRow('tech-1')], error: null },
    });
    const customers = chain({
      single: { data: { id: 'cust-1', tenant_id: 'tenant-uuid' }, error: null },
    });
    const skills = chain({ maybeSingle: { data: { id: 'skill-uuid-1' }, error: null } });
    // The post-insert re-read returns the row the decision function just wrote.
    const written = opts.rpc?.data as Array<{ status: string }> | undefined;
    const jobs = chain({
      maybeSingle: {
        data: jobRow(written?.[0]?.status ?? 'pending_approval'),
        error: null,
      },
    });
    const tables: Record<string, unknown> = {
      memberships,
      customers,
      skills,
      jobs,
    };
    const from = jest.fn((table: string) => {
      if (!(table in tables)) throw new Error(`unexpected table ${table}`);
      return tables[table];
    });
    const rpc = jest.fn().mockResolvedValue(
      opts.rpc ?? { data: [jobRow('pending_approval')], error: null },
    );
    factory.createAdmin.mockReturnValue({ from, rpc } as never);
    return { from, rpc, memberships, customers };
  }

  // ---- The employee path -----------------------------------------------------

  it('switch on and approval required: the job is saved pending, for the employee, created by them', async () => {
    const { rpc, memberships } = mockAdmin();

    const out = await service.createJob(employee, ownDto);

    expect(out.status).toBe('pending_approval');
    expect(rpc).toHaveBeenCalledWith(
      'create_job_with_log',
      expect.objectContaining({
        p_technician_id: 'tech-1',
        p_actor_id: 'tech-1',
        p_created_by: 'tech-1',
        p_pending_approval: true,
      }),
    );
    // The switch is read for the caller, in the caller's company, while active.
    expect(memberships.eq).toHaveBeenCalledWith('user_id', 'tech-1');
    expect(memberships.eq).toHaveBeenCalledWith('tenant_id', 'tenant-uuid');
    expect(memberships.eq).toHaveBeenCalledWith('status', 'active');
  });

  it('switch on and approval not required: the job is scheduled at once, created by the employee', async () => {
    const { rpc } = mockAdmin({
      submission: {
        data: { can_create_jobs: true, job_approval_required: false },
        error: null,
      },
      rpc: { data: [jobRow('scheduled')], error: null },
    });

    const out = await service.createJob(employee, ownDto);

    expect(out.status).toBe('scheduled');
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_created_by: 'tech-1',
      p_pending_approval: false,
    });
  });

  it('switch off: 403 before any customer is written or job created', async () => {
    const { rpc, customers } = mockAdmin({
      submission: {
        data: { can_create_jobs: false, job_approval_required: true },
        error: null,
      },
    });

    const err = await service.createJob(employee, ownDto).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ForbiddenException);
    expect(JSON.stringify((err as ForbiddenException).getResponse())).toContain(
      'Ask your owner to turn this on',
    );
    expect(rpc).not.toHaveBeenCalled();
    expect(customers.select).not.toHaveBeenCalled();
  });

  it('switch off with a new customer: the customer is not created either', async () => {
    const { rpc } = mockAdmin({
      submission: {
        data: { can_create_jobs: false, job_approval_required: true },
        error: null,
      },
    });
    const newCustomerDto: CreateJobDto = {
      ...ownDto,
      customerId: undefined,
      newCustomer: { name: 'Priya', countryCode: '+91', phoneNumber: '9876543210' },
    };

    await expect(service.createJob(employee, newCustomerDto)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(customersService.findOrCreateByPhone).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('no membership row for the employee in this company: 403, nothing written', async () => {
    const { rpc } = mockAdmin({ submission: { data: null, error: null } });

    await expect(service.createJob(employee, ownDto)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it('an employee cannot give a job to another technician: 403 and no reads at all', async () => {
    const { from, rpc } = mockAdmin();

    await expect(
      service.createJob(employee, { ...ownDto, technicianId: 'tech-2' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('a failed switch read is a 500, never a silent create', async () => {
    const { rpc } = mockAdmin({
      submission: { data: null, error: { code: 'XX000', message: 'db down' } },
    });

    await expect(service.createJob(employee, ownDto)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it('an owner creating a job reads no switch and the job is never pending', async () => {
    const { rpc, memberships } = mockAdmin();

    await service.createJob(owner, { ...ownDto, technicianId: 'tech-1' });

    // Only the technician membership check touches memberships; no switch read.
    expect(memberships.maybeSingle).not.toHaveBeenCalled();
    expect(memberships.eq).not.toHaveBeenCalledWith('user_id', 'owner-uuid');
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_actor_id: 'owner-uuid',
      p_created_by: 'owner-uuid',
      p_pending_approval: false,
    });
  });

  // ---- Lists must hide pending and rejected jobs from assigned work ---------

  describe('list scopes (CAP-4, CAP-7)', () => {
    const PENDING_OR_REJECTED = '(pending_approval,rejected)';

    function listAdmin() {
      const builder = chain({ limit: { data: [], error: null } });
      const from = jest.fn(() => builder);
      factory.createAdmin.mockReturnValue({ from } as never);
      return builder;
    }

    it('TODAY hides pending and rejected jobs for an owner', async () => {
      const builder = listAdmin();
      await service.listJobs(owner, {});
      expect(builder.not).toHaveBeenCalledWith('status', 'in', PENDING_OR_REJECTED);
    });

    it('TODAY hides pending and rejected jobs for an employee too', async () => {
      const builder = listAdmin();
      await service.listJobs(employee, {});
      expect(builder.not).toHaveBeenCalledWith('status', 'in', PENDING_OR_REJECTED);
    });

    it('TODAY keeps hiding them when the caller asks for a pending status', async () => {
      const builder = listAdmin();
      await service.listJobs(owner, {
        status: ['pending_approval'] as never,
      });
      expect(builder.not).toHaveBeenCalledWith('status', 'in', PENDING_OR_REJECTED);
    });

    it.each([
      [JobListScope.UPCOMING],
      [JobListScope.OVERDUE],
      [JobListScope.HISTORY],
    ])('scope %s never offers a pending job', async (scope) => {
      const builder = listAdmin();
      await service.listJobs(owner, { scope } as never);
      const statusArgs = [
        ...builder.in.mock.calls.filter((c) => c[0] === 'status').map((c) => c[1]),
        ...builder.eq.mock.calls.filter((c) => c[0] === 'status').map((c) => [c[1]]),
      ];
      const flat = statusArgs.flat(1) as unknown[];
      expect(flat).not.toContain('pending_approval');
      expect(flat.length).toBeGreaterThan(0);
    });
  });
});
