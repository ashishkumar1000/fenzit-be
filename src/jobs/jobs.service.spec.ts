import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { JobsService } from './jobs.service';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { CustomersService } from '../customers/customers.service';
import { StorageService } from '../storage/storage.service';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import { CreateJobDto } from './dto/create-job.dto';
import { UpdateJobDto } from './dto/update-job.dto';
import { ServiceType } from './enums/service-type.enum';
import { JobStatus } from './enums/job-status.enum';
import { JobPriority } from './enums/job-priority.enum';

describe('JobsService', () => {
  let service: JobsService;
  let supabaseClientFactory: jest.Mocked<SupabaseClientFactory>;
  let customersService: { findOrCreateByPhone: jest.Mock };

  const owner: RequestUser = {
    userId: 'owner-uuid',
    tenantId: 'tenant-uuid',
    role: Role.OWNER,
    rawJwt: 'jwt',
  };

  const ownerNoTenant: RequestUser = { ...owner, tenantId: null };

  const dtoExisting: CreateJobDto = {
    customerId: 'cust-1',
    serviceLocation: 'Loc',
    serviceType: ServiceType.AC_SERVICE,
    scheduledStart: '2026-06-22T09:30:00Z',
    technicianId: 'tech-1',
  };

  const dtoNew: CreateJobDto = {
    newCustomer: {
      name: 'Priya',
      countryCode: '+91',
      phoneNumber: '9876543210',
    },
    serviceLocation: 'Loc',
    serviceType: ServiceType.PLUMBING,
    scheduledStart: '2026-06-22T09:30:00Z',
    technicianId: 'tech-1',
  };

  const jobRow = {
    id: 'job-uuid',
    job_number: 'JB-2026-0001',
    tenant_id: 'tenant-uuid',
    customer_id: 'cust-1',
    technician_id: 'tech-1',
    service_location: 'Loc',
    service_type: 'ac_service',
    scheduled_start: '2026-06-22T09:30:00Z',
    scheduled_end: null,
    status: 'scheduled',
    current_step: null,
    priority: 'normal',
    require_completion_photo: false,
    description: null,
    notes_for_technician: null,
    created_at: '2026-06-21T00:00:00Z',
    updated_at: '2026-06-21T00:00:00Z',
  };

  const customerOk = {
    data: { id: 'cust-1', tenant_id: 'tenant-uuid' },
    error: null,
  };
  const technicianOk = {
    data: { id: 'tech-1', tenant_id: 'tenant-uuid', role: 'technician' },
    error: null,
  };
  const notFound = { data: null, error: { code: 'PGRST116' } };

  beforeEach(async () => {
    const mockFactory = { create: jest.fn(), createAdmin: jest.fn() };
    customersService = { findOrCreateByPhone: jest.fn() };
    const mockStorage = {
      getPresignedUploadUrl: jest
        .fn()
        .mockResolvedValue('https://r2.example.com/presigned'),
      getPresignedReadUrl: jest
        .fn()
        .mockResolvedValue('https://r2.example.com/read'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JobsService,
        { provide: SupabaseClientFactory, useValue: mockFactory },
        { provide: CustomersService, useValue: customersService },
        { provide: StorageService, useValue: mockStorage },
      ],
    }).compile();

    service = module.get<JobsService>(JobsService);
    supabaseClientFactory = module.get(SupabaseClientFactory);
  });

  // Builds a select().eq()...single() chain with `eqCount` eq() calls.
  function singleChain(
    result: { data: unknown; error: unknown },
    eqCount: number,
  ) {
    const single = jest.fn().mockResolvedValue(result);
    // `eqs` holds the eq mocks in chain-call order (eqs[0] = first .eq called),
    // so tests can assert the tenant_id filter is actually applied.
    const eqs: jest.Mock[] = [];
    let node: Record<string, unknown> = { single };
    for (let i = 0; i < eqCount; i++) {
      const inner = node;
      const eq = jest.fn().mockReturnValue(inner);
      eqs.unshift(eq);
      node = { eq };
    }
    const select = jest.fn().mockReturnValue(node);
    return { select, eqs };
  }

  // admin.from('customers') → 2 eq (id, tenant); from('users') → 3 eq (id, tenant, role).
  function mockAdmin(opts: {
    customer?: { data: unknown; error: unknown };
    technician?: { data: unknown; error: unknown };
    rpc?: { data: unknown; error: unknown };
  }) {
    const from = jest.fn((table: string) => {
      if (table === 'customers')
        return singleChain(opts.customer ?? customerOk, 2);
      if (table === 'users')
        return singleChain(opts.technician ?? technicianOk, 3);
      throw new Error(`unexpected table ${table}`);
    });
    const rpc = jest
      .fn()
      .mockResolvedValue(opts.rpc ?? { data: [jobRow], error: null });
    supabaseClientFactory.createAdmin.mockReturnValue({ from, rpc } as never);
    return { from, rpc };
  }

  async function expectStatus(promise: Promise<unknown>, status: number) {
    await expect(promise).rejects.toBeInstanceOf(HttpException);
    await promise.catch((e: HttpException) => {
      expect(e.getStatus()).toBe(status);
    });
  }

  it('creates a job (existing customerId path) and maps to camelCase', async () => {
    const { rpc, from } = mockAdmin({});

    const result = await service.createJob(owner, dtoExisting);

    expect(result.jobNumber).toBe('JB-2026-0001');
    expect(result.status).toBe('scheduled');
    expect(result.currentStep).toBeNull();
    expect(result.tenantId).toBe('tenant-uuid');
    expect(result.customerId).toBe('cust-1');
    expect(from).toHaveBeenCalledWith('customers'); // existing-customer validation
    expect(customersService.findOrCreateByPhone).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith(
      'create_job_with_log',
      expect.objectContaining({
        p_tenant_id: 'tenant-uuid',
        p_customer_id: 'cust-1',
        p_technician_id: 'tech-1',
        p_actor_id: 'owner-uuid',
        p_service_type: 'ac_service',
      }),
    );
  });

  it('creates a job (newCustomer path) via findOrCreateByPhone and skips customer validation', async () => {
    customersService.findOrCreateByPhone.mockResolvedValue({
      id: 'cust-new',
      createdVia: 'job_creation',
    });
    const { from, rpc } = mockAdmin({});

    const result = await service.createJob(owner, dtoNew);

    expect(customersService.findOrCreateByPhone).toHaveBeenCalledWith(
      owner,
      dtoNew.newCustomer,
    );
    // no customers table validation query on the newCustomer path
    expect(from).not.toHaveBeenCalledWith('customers');
    expect(rpc).toHaveBeenCalledWith(
      'create_job_with_log',
      expect.objectContaining({ p_customer_id: 'cust-new' }),
    );
    expect(result.jobNumber).toBe('JB-2026-0001');
  });

  it('passes the IST creation year to the RPC as p_year', async () => {
    const { rpc } = mockAdmin({});

    await service.createJob(owner, dtoExisting);

    const callArg = rpc.mock.calls[0][1] as { p_year: number };
    expect(typeof callArg.p_year).toBe('number');
    expect(callArg.p_year).toBeGreaterThanOrEqual(2026);
  });

  it('throws 404 when the technician is not in the tenant', async () => {
    mockAdmin({ technician: notFound });

    await expect(service.createJob(owner, dtoExisting)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('throws 404 when the existing customerId is not in the tenant', async () => {
    mockAdmin({ customer: notFound });

    await expect(service.createJob(owner, dtoExisting)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('throws 422 when neither customerId nor newCustomer is provided', async () => {
    const dto = { ...dtoExisting, customerId: undefined };
    await expectStatus(
      service.createJob(owner, dto),
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  });

  it('throws 422 when both customerId and newCustomer are provided', async () => {
    const dto = { ...dtoExisting, newCustomer: dtoNew.newCustomer };
    await expectStatus(
      service.createJob(owner, dto),
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  });

  it('throws 400 when the owner has no tenantId', async () => {
    await expect(service.createJob(ownerNoTenant, dtoExisting)).rejects.toThrow(
      BadRequestException,
    );
    expect(supabaseClientFactory.createAdmin).not.toHaveBeenCalled();
  });

  it('throws 500 when the RPC returns an error', async () => {
    mockAdmin({
      rpc: { data: null, error: { code: 'XX000', message: 'boom' } },
    });

    await expect(service.createJob(owner, dtoExisting)).rejects.toThrow(
      InternalServerErrorException,
    );
  });

  it('throws 500 when the RPC returns no rows', async () => {
    mockAdmin({ rpc: { data: [], error: null } });

    await expect(service.createJob(owner, dtoExisting)).rejects.toThrow(
      InternalServerErrorException,
    );
  });

  it('throws 404 when the RPC raises an FK violation (23503 — raced delete)', async () => {
    mockAdmin({ rpc: { data: null, error: { code: '23503', message: 'fk' } } });

    await expect(service.createJob(owner, dtoExisting)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('throws 422 when scheduledEnd is before scheduledStart', async () => {
    const dto: CreateJobDto = {
      ...dtoExisting,
      scheduledStart: '2026-06-22T11:00:00Z',
      scheduledEnd: '2026-06-22T09:30:00Z',
    };
    await expectStatus(
      service.createJob(owner, dto),
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  });

  it('passes all optional fields through to the RPC', async () => {
    const { rpc } = mockAdmin({});
    const dto: CreateJobDto = {
      ...dtoExisting,
      scheduledEnd: '2026-06-22T11:00:00Z',
      description: 'Leaky AC',
      priority: JobPriority.URGENT,
      requireCompletionPhoto: true,
      notesForTechnician: 'Bring ladder',
    };

    await service.createJob(owner, dto);

    expect(rpc).toHaveBeenCalledWith(
      'create_job_with_log',
      expect.objectContaining({
        p_scheduled_end: '2026-06-22T11:00:00Z',
        p_description: 'Leaky AC',
        p_priority: 'urgent',
        p_require_completion_photo: true,
        p_notes_for_technician: 'Bring ladder',
      }),
    );
  });

  describe('listJobs', () => {
    const technician: RequestUser = {
      userId: 'tech-self',
      tenantId: 'tenant-uuid',
      role: Role.TECHNICIAN,
      rawJwt: 'jwt',
    };

    // Chainable list builder: every filter/order returns the builder; .limit()
    // resolves to { data, error }. Returned so tests can inspect call args.
    function listChain(result: { data: unknown; error: unknown }) {
      const builder: Record<string, jest.Mock> = {};
      for (const m of ['select', 'eq', 'gte', 'lt', 'in', 'or', 'order']) {
        builder[m] = jest.fn().mockReturnValue(builder);
      }
      builder.limit = jest.fn().mockResolvedValue(result);
      return builder;
    }

    function mockListAdmin(result: { data: unknown; error: unknown }) {
      const builder = listChain(result);
      const from = jest.fn().mockReturnValue(builder);
      supabaseClientFactory.createAdmin.mockReturnValue({ from } as never);
      return { from, builder };
    }

    it('lists the tenant jobs for today (IST window) mapped to camelCase', async () => {
      const { from, builder } = mockListAdmin({ data: [jobRow], error: null });

      const result = await service.listJobs(owner, {});

      expect(from).toHaveBeenCalledWith('jobs');
      expect(builder.eq).toHaveBeenCalledWith('tenant_id', 'tenant-uuid');
      expect(builder.gte).toHaveBeenCalledWith(
        'scheduled_start',
        expect.any(String),
      );
      expect(builder.lt).toHaveBeenCalledWith(
        'scheduled_start',
        expect.any(String),
      );
      // AC#7 — sort is created_at DESC, id DESC (NOT scheduled_start).
      expect(builder.order).toHaveBeenCalledWith('created_at', {
        ascending: false,
      });
      expect(builder.order).toHaveBeenCalledWith('id', { ascending: false });
      // AC#1 — each entry is the full job object (same shape POST returns).
      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toEqual({
        id: 'job-uuid',
        jobNumber: 'JB-2026-0001',
        tenantId: 'tenant-uuid',
        customerId: 'cust-1',
        technicianId: 'tech-1',
        serviceLocation: 'Loc',
        serviceType: 'ac_service',
        scheduledStart: '2026-06-22T09:30:00Z',
        scheduledEnd: null,
        status: 'scheduled',
        currentStep: null,
        priority: 'normal',
        requireCompletionPhoto: false,
        description: null,
        notesForTechnician: null,
        createdAt: '2026-06-21T00:00:00Z',
        updatedAt: '2026-06-21T00:00:00Z',
      });
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeNull();
    });

    it('sets nextCursor when a full page + 1 rows are returned', async () => {
      const rows = Array.from({ length: 51 }, (_, i) => ({
        ...jobRow,
        id: `job-${i}`,
        created_at: `2026-06-21T00:00:${String(i).padStart(2, '0')}Z`,
      }));
      mockListAdmin({ data: rows, error: null });

      const result = await service.listJobs(owner, {});

      expect(result.data).toHaveLength(50);
      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).not.toBeNull();
      // Cursor encodes the 50th (last returned) row.
      const decoded = JSON.parse(
        Buffer.from(result.nextCursor as string, 'base64url').toString('utf-8'),
      ) as { id: string; createdAt: string };
      expect(decoded.id).toBe('job-49');
    });

    it('returns no cursor at exactly PAGE_SIZE rows (boundary)', async () => {
      const rows = Array.from({ length: 50 }, (_, i) => ({
        ...jobRow,
        id: `job-${i}`,
        created_at: `2026-06-21T00:00:${String(i).padStart(2, '0')}Z`,
      }));
      mockListAdmin({ data: rows, error: null });

      const result = await service.listJobs(owner, {});

      // Exactly PAGE_SIZE → no extra row → hasMore false, no cursor (off-by-one trap).
      expect(result.data).toHaveLength(50);
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeNull();
    });

    it('returns an empty page (not 404) when nothing matches', async () => {
      mockListAdmin({ data: [], error: null });

      const result = await service.listJobs(owner, {});

      expect(result.data).toEqual([]);
      expect(result.nextCursor).toBeNull();
      expect(result.hasMore).toBe(false);
    });

    it('forces technician_id = caller for a technician and ignores query technicianId', async () => {
      const { builder } = mockListAdmin({ data: [], error: null });

      await service.listJobs(technician, {
        technicianId: 'some-other-tech',
      });

      expect(builder.eq).toHaveBeenCalledWith('technician_id', 'tech-self');
      expect(builder.eq).not.toHaveBeenCalledWith(
        'technician_id',
        'some-other-tech',
      );
    });

    it('applies the owner technicianId filter when provided', async () => {
      const { builder } = mockListAdmin({ data: [], error: null });

      await service.listJobs(owner, {
        technicianId: 'tech-1',
      });

      expect(builder.eq).toHaveBeenCalledWith('technician_id', 'tech-1');
    });

    it('applies the repeatable status filter via .in()', async () => {
      const { builder } = mockListAdmin({ data: [], error: null });

      await service.listJobs(owner, {
        status: [JobStatus.SCHEDULED, JobStatus.IN_PROGRESS],
      });

      expect(builder.in).toHaveBeenCalledWith('status', [
        'scheduled',
        'in_progress',
      ]);
    });

    it('uses the explicit date IST window when date is provided', async () => {
      const { builder } = mockListAdmin({ data: [], error: null });

      await service.listJobs(owner, { date: '2026-06-20' });

      // IST day 2026-06-20 = [2026-06-19T18:30Z, 2026-06-20T18:30Z).
      expect(builder.gte).toHaveBeenCalledWith(
        'scheduled_start',
        '2026-06-19T18:30:00.000Z',
      );
      expect(builder.lt).toHaveBeenCalledWith(
        'scheduled_start',
        '2026-06-20T18:30:00.000Z',
      );
    });

    it('applies the keyset cursor OR-filter when a cursor is supplied', async () => {
      const { builder } = mockListAdmin({ data: [], error: null });
      const cursor = Buffer.from(
        JSON.stringify({
          id: '11111111-1111-4111-8111-111111111111',
          createdAt: '2026-06-21T00:00:00.000Z',
        }),
      ).toString('base64url');

      await service.listJobs(owner, { cursor });

      // Assert the FULL keyset predicate, including the (created_at, id) tie-break
      // — that and(...) clause is what makes pagination gapless on equal created_at.
      expect(builder.or).toHaveBeenCalledWith(
        'created_at.lt.2026-06-21T00:00:00.000Z,' +
          'and(created_at.eq.2026-06-21T00:00:00.000Z,' +
          'id.lt.11111111-1111-4111-8111-111111111111)',
      );
    });

    it('throws 400 when the caller has no tenantId', async () => {
      await expect(service.listJobs(ownerNoTenant, {})).rejects.toThrow(
        BadRequestException,
      );
      expect(supabaseClientFactory.createAdmin).not.toHaveBeenCalled();
    });

    it('throws 500 when the list query errors', async () => {
      mockListAdmin({ data: null, error: { code: 'XX000', message: 'boom' } });

      await expect(service.listJobs(owner, {})).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('getJobDetail', () => {
    const technicianRow = {
      id: 'tech-1',
      name: 'Ravi',
      country_code: '+91',
      phone_number: '9990001111',
    };
    const customerRow = {
      id: 'cust-1',
      name: 'Priya',
      country_code: '+91',
      phone_number: '9876543210',
      address: '12 MG Road',
      city: 'Pune',
    };
    const skillRows = [
      { tenant_skills: { name: 'AC Repair' } },
      { tenant_skills: { name: 'Plumbing' } },
    ];
    const logRows = [
      {
        id: 'log-1',
        event_type: 'job_created',
        actor_id: 'owner-uuid',
        metadata: {},
        created_at: '2026-06-21T00:00:00Z',
      },
      {
        id: 'log-2',
        event_type: 'job_reassigned',
        actor_id: 'owner-uuid',
        metadata: null,
        created_at: '2026-06-21T01:00:00Z',
      },
    ];

    const techOwn: RequestUser = {
      userId: 'tech-1', // matches jobRow.technician_id
      tenantId: 'tenant-uuid',
      role: Role.TECHNICIAN,
      rawJwt: 'jwt',
    };
    const techOther: RequestUser = { ...techOwn, userId: 'tech-self' };

    // Dispatch by table — chains have different terminals: jobs/users/customers
    // end in .single(); user_skills ends in .eq(); activity_logs/.order() ends in .order().
    function mockDetailAdmin(opts: {
      job?: { data: unknown; error: unknown };
      technician?: { data: unknown; error: unknown };
      skills?: { data: unknown; error: unknown };
      customer?: { data: unknown; error: unknown };
      logs?: { data: unknown; error: unknown };
      attachments?: { data: unknown; error: unknown };
    }) {
      const activityOrder = jest
        .fn()
        .mockResolvedValue(opts.logs ?? { data: logRows, error: null });
      // user_skills now chains TWO eq calls: .eq('user_id').eq('tenant_skills.tenant_id').
      const skillsEq2 = jest
        .fn()
        .mockResolvedValue(opts.skills ?? { data: skillRows, error: null });
      const skillsEq1 = jest.fn().mockReturnValue({ eq: skillsEq2 });
      const logEq2 = jest.fn().mockReturnValue({ order: activityOrder });
      const logEq1 = jest.fn().mockReturnValue({ eq: logEq2 });
      const attachOrder = jest
        .fn()
        .mockResolvedValue(opts.attachments ?? { data: [], error: null });
      const attachEq2 = jest.fn().mockReturnValue({ order: attachOrder });
      const attachEq1 = jest.fn().mockReturnValue({ eq: attachEq2 });
      const chains: Record<string, { select: jest.Mock; eqs: jest.Mock[] }> =
        {};
      const from = jest.fn((table: string) => {
        if (table === 'jobs') {
          chains.jobs = singleChain(
            opts.job ?? { data: jobRow, error: null },
            2,
          );
          return chains.jobs;
        }
        if (table === 'users') {
          chains.users = singleChain(
            opts.technician ?? { data: technicianRow, error: null },
            2,
          );
          return chains.users;
        }
        if (table === 'customers') {
          chains.customers = singleChain(
            opts.customer ?? { data: customerRow, error: null },
            2,
          );
          return chains.customers;
        }
        if (table === 'user_skills')
          return { select: jest.fn().mockReturnValue({ eq: skillsEq1 }) };
        if (table === 'activity_logs')
          return { select: jest.fn().mockReturnValue({ eq: logEq1 }) };
        if (table === 'attachments')
          return { select: jest.fn().mockReturnValue({ eq: attachEq1 }) };
        throw new Error(`unexpected table ${table}`);
      });
      supabaseClientFactory.createAdmin.mockReturnValue({ from } as never);
      return {
        from,
        activityOrder,
        chains,
        skillsEq1,
        skillsEq2,
        logEq1,
        logEq2,
      };
    }

    it('returns the full job detail with nested profiles, activity log, and empty attachments (owner)', async () => {
      mockDetailAdmin({});

      const result = await service.getJobDetail(owner, 'job-uuid');

      expect(result.id).toBe('job-uuid');
      expect(result.jobNumber).toBe('JB-2026-0001'); // base job fields present
      expect(result.technician).toEqual({
        id: 'tech-1',
        name: 'Ravi',
        countryCode: '+91',
        phoneNumber: '9990001111',
        skills: ['AC Repair', 'Plumbing'],
      });
      expect(result.customer).toEqual({
        id: 'cust-1',
        name: 'Priya',
        countryCode: '+91',
        phoneNumber: '9876543210',
        address: '12 MG Road',
        city: 'Pune',
      });
      expect(result.activityLog).toEqual([
        {
          id: 'log-1',
          eventType: 'job_created',
          actorId: 'owner-uuid',
          metadata: {},
          createdAt: '2026-06-21T00:00:00Z',
        },
        {
          id: 'log-2',
          eventType: 'job_reassigned',
          actorId: 'owner-uuid',
          metadata: null,
          createdAt: '2026-06-21T01:00:00Z',
        },
      ]);
      // AC#18 — attachments populated; empty when none confirmed.
      expect(result.attachments).toEqual([]);
    });

    it('orders the activity log oldest-first (created_at ASC)', async () => {
      const { activityOrder } = mockDetailAdmin({});

      const result = await service.getJobDetail(owner, 'job-uuid');

      expect(activityOrder).toHaveBeenCalledWith('created_at', {
        ascending: true,
      });
      expect(result.activityLog.map((l) => l.id)).toEqual(['log-1', 'log-2']);
    });

    it('returns [] skills when the technician has none', async () => {
      mockDetailAdmin({ skills: { data: [], error: null } });

      const result = await service.getJobDetail(owner, 'job-uuid');

      expect(result.technician.skills).toEqual([]);
    });

    it('allows a technician to view their own assigned job', async () => {
      mockDetailAdmin({});

      const result = await service.getJobDetail(techOwn, 'job-uuid');

      expect(result.id).toBe('job-uuid');
    });

    it('throws 403 when a technician requests a job not assigned to them', async () => {
      mockDetailAdmin({});

      await expect(service.getJobDetail(techOther, 'job-uuid')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('throws 404 when the job does not exist / is in another tenant', async () => {
      mockDetailAdmin({ job: { data: null, error: { code: 'PGRST116' } } });

      await expect(service.getJobDetail(owner, 'missing')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws 400 when the caller has no tenantId', async () => {
      await expect(
        service.getJobDetail(ownerNoTenant, 'job-uuid'),
      ).rejects.toThrow(BadRequestException);
      expect(supabaseClientFactory.createAdmin).not.toHaveBeenCalled();
    });

    it('throws 500 when the job fetch errors (non-PGRST116)', async () => {
      mockDetailAdmin({
        job: { data: null, error: { code: 'XX000', message: 'boom' } },
      });

      await expect(service.getJobDetail(owner, 'job-uuid')).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('throws 500 when a related-record fetch errors', async () => {
      mockDetailAdmin({
        customer: { data: null, error: { code: 'XX000', message: 'boom' } },
      });

      await expect(service.getJobDetail(owner, 'job-uuid')).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('throws 500 when a NOT-NULL FK row is missing (PGRST116 on technician)', async () => {
      mockDetailAdmin({
        technician: { data: null, error: { code: 'PGRST116' } },
      });

      await expect(service.getJobDetail(owner, 'job-uuid')).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('throws 500 when a NOT-NULL FK row is missing (PGRST116 on customer)', async () => {
      mockDetailAdmin({
        customer: { data: null, error: { code: 'PGRST116' } },
      });

      await expect(service.getJobDetail(owner, 'job-uuid')).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('scopes every related read to the caller tenant (defense-in-depth)', async () => {
      const m = mockDetailAdmin({});

      await service.getJobDetail(owner, 'job-uuid');

      // job fetch: .eq('id', jobId).eq('tenant_id', tenantId)
      expect(m.chains.jobs.eqs[0]).toHaveBeenCalledWith('id', 'job-uuid');
      expect(m.chains.jobs.eqs[1]).toHaveBeenCalledWith(
        'tenant_id',
        'tenant-uuid',
      );
      // technician + customer: second eq is the tenant filter
      expect(m.chains.users.eqs[1]).toHaveBeenCalledWith(
        'tenant_id',
        'tenant-uuid',
      );
      expect(m.chains.customers.eqs[1]).toHaveBeenCalledWith(
        'tenant_id',
        'tenant-uuid',
      );
      // skills: scoped via the embedded tenant_skills
      expect(m.skillsEq1).toHaveBeenCalledWith('user_id', 'tech-1');
      expect(m.skillsEq2).toHaveBeenCalledWith(
        'tenant_skills.tenant_id',
        'tenant-uuid',
      );
      // activity_logs: .eq('job_id', jobId).eq('tenant_id', tenantId)
      expect(m.logEq1).toHaveBeenCalledWith('job_id', 'job-uuid');
      expect(m.logEq2).toHaveBeenCalledWith('tenant_id', 'tenant-uuid');
    });

    it('normalizes both PostgREST embed shapes and drops empty skill names', async () => {
      mockDetailAdmin({
        skills: {
          data: [
            { tenant_skills: [{ name: 'AC Repair' }, { name: 'Plumbing' }] }, // array shape
            { tenant_skills: { name: 'Wiring' } }, // object shape
            { tenant_skills: null }, // no skill
            { tenant_skills: { name: '' } }, // empty name → dropped
          ],
          error: null,
        },
      });

      const result = await service.getJobDetail(owner, 'job-uuid');

      expect(result.technician.skills).toEqual([
        'AC Repair',
        'Plumbing',
        'Wiring',
      ]);
    });
  });

  describe('updateJob', () => {
    it('edits a scheduled job (no cancel, no reassign) and maps to camelCase', async () => {
      const { rpc, from } = mockAdmin({});

      const dto: UpdateJobDto = {
        description: 'edited',
        priority: JobPriority.URGENT,
      };
      const result = await service.updateJob(owner, 'job-uuid', dto);

      expect(result.id).toBe('job-uuid');
      expect(result.jobNumber).toBe('JB-2026-0001');
      // no technicianId → no technician validation read
      expect(from).not.toHaveBeenCalledWith('users');
      expect(rpc).toHaveBeenCalledWith(
        'update_job_with_log',
        expect.objectContaining({
          p_job_id: 'job-uuid',
          p_tenant_id: 'tenant-uuid',
          p_actor_id: 'owner-uuid',
          p_cancel: false,
          p_description: 'edited',
          p_priority: 'urgent',
          p_technician_id: null,
        }),
      );
    });

    it('reassigns to a valid technician: validates the technician then calls the RPC', async () => {
      const { rpc, from } = mockAdmin({});

      const dto: UpdateJobDto = { technicianId: 'tech-2' };
      await service.updateJob(owner, 'job-uuid', dto);

      expect(from).toHaveBeenCalledWith('users'); // technician validated
      expect(rpc).toHaveBeenCalledWith(
        'update_job_with_log',
        expect.objectContaining({ p_cancel: false, p_technician_id: 'tech-2' }),
      );
    });

    it('reassigning to the same technician still passes p_technician_id (log suppression is RPC-internal)', async () => {
      const { rpc } = mockAdmin({});

      await service.updateJob(owner, 'job-uuid', { technicianId: 'tech-1' });

      expect(rpc).toHaveBeenCalledWith(
        'update_job_with_log',
        expect.objectContaining({ p_technician_id: 'tech-1' }),
      );
    });

    it('cancels a scheduled job via { status: cancelled } with p_cancel = true', async () => {
      const { rpc, from } = mockAdmin({});

      const dto: UpdateJobDto = { status: JobStatus.CANCELLED };
      await service.updateJob(owner, 'job-uuid', dto);

      // cancel is not a reassignment → no technician validation
      expect(from).not.toHaveBeenCalledWith('users');
      expect(rpc).toHaveBeenCalledWith(
        'update_job_with_log',
        expect.objectContaining({ p_cancel: true, p_technician_id: null }),
      );
    });

    it('throws 409 JOB_NOT_MODIFIABLE when the RPC raises PT409 (non-scheduled job)', async () => {
      mockAdmin({
        rpc: {
          data: null,
          error: { code: 'PT409', message: 'not modifiable' },
        },
      });

      await expectStatus(
        service.updateJob(owner, 'job-uuid', { description: 'x' }),
        HttpStatus.CONFLICT,
      );
    });

    it('throws 404 when the RPC returns no rows (missing / cross-tenant job)', async () => {
      mockAdmin({ rpc: { data: [], error: null } });

      await expect(
        service.updateJob(owner, 'job-uuid', { description: 'x' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws 404 when the new technician is not in the tenant', async () => {
      mockAdmin({ technician: notFound });

      await expect(
        service.updateJob(owner, 'job-uuid', { technicianId: 'ghost' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws 404 when the RPC raises an FK violation (23503 — raced technician delete)', async () => {
      mockAdmin({
        rpc: { data: null, error: { code: '23503', message: 'fk' } },
      });

      await expect(
        service.updateJob(owner, 'job-uuid', { technicianId: 'tech-2' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws 500 when the RPC returns an unexpected error', async () => {
      mockAdmin({
        rpc: { data: null, error: { code: 'XX000', message: 'boom' } },
      });

      await expect(
        service.updateJob(owner, 'job-uuid', { description: 'x' }),
      ).rejects.toThrow(InternalServerErrorException);
    });

    it('throws 400 when the owner has no tenantId', async () => {
      await expect(
        service.updateJob(ownerNoTenant, 'job-uuid', { description: 'x' }),
      ).rejects.toThrow(BadRequestException);
      expect(supabaseClientFactory.createAdmin).not.toHaveBeenCalled();
    });

    it('throws 422 on an empty body (no updatable fields)', async () => {
      await expectStatus(
        service.updateJob(owner, 'job-uuid', {}),
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
      expect(supabaseClientFactory.createAdmin).not.toHaveBeenCalled();
    });

    it('throws 422 when cancellation is combined with a field edit', async () => {
      await expectStatus(
        service.updateJob(owner, 'job-uuid', {
          status: JobStatus.CANCELLED,
          description: 'x',
        }),
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
      expect(supabaseClientFactory.createAdmin).not.toHaveBeenCalled();
    });

    it('throws 422 when scheduledEnd is before scheduledStart', async () => {
      await expectStatus(
        service.updateJob(owner, 'job-uuid', {
          scheduledStart: '2026-06-22T11:00:00Z',
          scheduledEnd: '2026-06-22T09:30:00Z',
        }),
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    });

    it('throws 422 when a one-sided edit inverts the stored window (RPC PT422)', async () => {
      // Only one bound is supplied, so the service-level both-present check can't
      // catch it; the RPC computes the effective window and raises PT422.
      mockAdmin({
        rpc: {
          data: null,
          error: {
            code: 'PT422',
            message: 'scheduled_end before scheduled_start',
          },
        },
      });

      await expectStatus(
        service.updateJob(owner, 'job-uuid', {
          scheduledStart: '2026-06-22T23:00:00Z',
        }),
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    });
  });
});
