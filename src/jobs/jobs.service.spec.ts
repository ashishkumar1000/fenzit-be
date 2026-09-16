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
import { JobStatus } from './enums/job-status.enum';
import { JobListScope } from './enums/job-list-scope.enum';
import { JobPriority } from './enums/job-priority.enum';
import {
  parseTemplateSteps,
  stepToResponse,
  TemplateStep,
} from './workflow-template.model';

// The v1 seed chain (migration 20260911000002). src/ unit specs keep their own
// inline copy — the shared copy lives at test/fixtures/v1-template.ts and is
// out of jest's src rootDir boundary.
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

// The v1 steps as the API maps them (camelCase) — reused by exact-shape pins.
const V1_STEPS_RESPONSE = (parseTemplateSteps(V1_STEPS) as TemplateStep[]).map(
  stepToResponse,
);

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
    skillId: 'skill-uuid-1',
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
    skillId: 'skill-uuid-2',
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
    scheduled_start: '2026-06-22T09:30:00Z',
    scheduled_end: null,
    status: 'scheduled',
    completed_at: null,
    current_step: null,
    priority: 'normal',
    description: null,
    notes_for_technician: null,
    created_at: '2026-06-21T00:00:00Z',
    updated_at: '2026-06-21T00:00:00Z',
    // Story 4.5 — the FK embeds every job read selects.
    skill_id: 'skill-uuid-1',
    skills: { id: 'skill-uuid-1', name: 'Plumbing' },
    workflow_templates: { version: 1, steps: V1_STEPS },
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

  // Builds a select().eq()...single()/maybeSingle() chain with `eqCount` eq()
  // calls. The terminator matches the service call under test.
  function singleChain(
    result: { data: unknown; error: unknown },
    eqCount: number,
    terminator: 'single' | 'maybeSingle' = 'single',
  ) {
    const single = jest.fn().mockResolvedValue(result);
    // `eqs` holds the eq mocks in chain-call order (eqs[0] = first .eq called),
    // so tests can assert the tenant_id filter is actually applied.
    const eqs: jest.Mock[] = [];
    let node: Record<string, unknown> =
      terminator === 'single' ? { single } : { maybeSingle: single };
    for (let i = 0; i < eqCount; i++) {
      const inner = node;
      const eq = jest.fn().mockReturnValue(inner);
      eqs.unshift(eq);
      node = { eq };
    }
    const select = jest.fn().mockReturnValue(node);
    return { select, eqs, single };
  }

  // Story 4.3 — skills-catalog validation chain: select().eq(id).eq(is_active)
  // .maybeSingle(). A miss (data: null) is the 400 "unknown or inactive" case.
  // `eqs` exposes both eq mocks so tests can assert the is_active filter is
  // actually applied (mirror of singleChain above / auth.service.spec).
  const skillOk = { data: { id: 'skill-uuid-1' }, error: null };
  function skillsChain(result: { data: unknown; error: unknown }) {
    const maybeSingle = jest.fn().mockResolvedValue(result);
    const eqs: jest.Mock[] = [];
    let node: Record<string, unknown> = { maybeSingle };
    for (let i = 0; i < 2; i++) {
      const inner = node;
      const eq = jest.fn().mockReturnValue(inner);
      eqs.unshift(eq);
      node = { eq };
    }
    const select = jest.fn().mockReturnValue(node);
    return { select, eqs };
  }

  // admin.from('customers') → 2 eq (id, tenant); from('users') → 3 eq (id, tenant, role);
  // from('skills') → 2 eq (id, is_active); from('jobs') → 2 eq (id, tenant) +
  // maybeSingle — the Story 4.5 post-RPC embed re-fetch (refetchWithEmbeds).
  function mockAdmin(opts: {
    customer?: { data: unknown; error: unknown };
    technician?: { data: unknown; error: unknown };
    skill?: { data: unknown; error: unknown };
    rpc?: { data: unknown; error: unknown };
    refetch?: { data: unknown; error: unknown };
  }) {
    const chains: Record<string, { select: jest.Mock; eqs: jest.Mock[] }> = {};
    const from = jest.fn((table: string) => {
      if (table === 'customers') {
        chains.customers = singleChain(opts.customer ?? customerOk, 2);
        return chains.customers;
      }
      if (table === 'users') {
        chains.users = singleChain(opts.technician ?? technicianOk, 3);
        return chains.users;
      }
      if (table === 'skills') {
        chains.skills = skillsChain(opts.skill ?? skillOk);
        return chains.skills;
      }
      if (table === 'jobs') {
        chains.jobs = singleChain(
          opts.refetch ?? { data: jobRow, error: null },
          2,
          'maybeSingle',
        );
        return chains.jobs;
      }
      throw new Error(`unexpected table ${table}`);
    });
    const rpc = jest
      .fn()
      .mockResolvedValue(opts.rpc ?? { data: [jobRow], error: null });
    supabaseClientFactory.createAdmin.mockReturnValue({ from, rpc } as never);
    return { from, rpc, chains };
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
        p_skill_id: 'skill-uuid-1',
      }),
    );
    // Story 4.4 — the job-level completion flags are gone: the create RPC
    // carries no flag params (the stamped template drives photo/signature
    // behaviour as step attributes).
    const rpcArgs = rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(rpcArgs).not.toHaveProperty('p_require_completion_photo');
    expect(rpcArgs).not.toHaveProperty('p_require_completion_signature');
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

  it('carries completed_at from the re-fetched row through toResponse (create route)', async () => {
    // Story 4.5 — the response row is the post-RPC embed re-fetch, not the
    // bare RPC row; the completed_at carry-over rides that re-fetch.
    mockAdmin({
      rpc: {
        data: [
          {
            ...jobRow,
            status: JobStatus.COMPLETED,
            completed_at: '2026-06-22T10:00:00Z',
          },
        ],
        error: null,
      },
      refetch: {
        data: {
          ...jobRow,
          status: JobStatus.COMPLETED,
          completed_at: '2026-06-22T10:00:00Z',
        },
        error: null,
      },
    });

    const result = await service.createJob(owner, dtoExisting);

    expect(result.status).toBe('completed');
    expect(result.completedAt).toBe('2026-06-22T10:00:00Z');
  });

  it('falls back to the RPC row when the embed re-fetch fails (write already succeeded — never a 500)', async () => {
    // A write RPC returns a BARE job row (RETURNS SETOF jobs) — no embeds.
    const bareRpcRow = {
      ...jobRow,
      skill_id: undefined,
      skills: undefined,
      workflow_templates: undefined,
    };
    mockAdmin({
      rpc: {
        data: [
          {
            ...bareRpcRow,
            status: JobStatus.COMPLETED,
            completed_at: '2026-06-22T10:00:00Z',
          },
        ],
        error: null,
      },
      refetch: { data: null, error: { code: 'XX000' } },
    });

    const result = await service.createJob(owner, dtoExisting);

    // The RPC row's own fields still carry; the embeds degrade to null.
    expect(result.status).toBe('completed');
    expect(result.completedAt).toBe('2026-06-22T10:00:00Z');
    expect(result.skill).toBeNull();
    expect(result.workflowTemplate).toBeNull();
    expect(result.currentStepIndex).toBeNull();
  });

  it('maps the stamped skill + template + currentStepIndex onto the create response (Story 4.5)', async () => {
    mockAdmin({ refetch: { data: { ...jobRow }, error: null } });

    const result = await service.createJob(owner, dtoExisting);

    expect(result.skill).toEqual({ id: 'skill-uuid-1', name: 'Plumbing' });
    expect(result.workflowTemplate).toEqual({
      version: 1,
      steps: V1_STEPS_RESPONSE,
    });
    // Fresh job (current_step null) → null index, full steps list still present.
    expect(result.currentStepIndex).toBeNull();
    expect(result.workflowTemplate?.steps).toHaveLength(6);
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

  it('throws 400 when skillId is unknown or inactive (rejected before the RPC, Story 4.3)', async () => {
    const { rpc, from, chains } = mockAdmin({
      skill: { data: null, error: null },
    });

    await expect(service.createJob(owner, dtoExisting)).rejects.toThrow(
      BadRequestException,
    );
    expect(from).toHaveBeenCalledWith('skills');
    // The chain must filter on the exact id AND is_active — a chain that
    // resolves without .eq('is_active', true) would treat inactive skills as
    // valid (mirror of auth.service.spec's skillCheckEq assertion).
    expect(chains.skills?.eqs[0]).toHaveBeenCalledWith('id', 'skill-uuid-1');
    expect(chains.skills?.eqs[1]).toHaveBeenCalledWith('is_active', true);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('throws 500 when the skills-catalog lookup errors', async () => {
    mockAdmin({ skill: { data: null, error: { code: 'XX000' } } });

    await expect(service.createJob(owner, dtoExisting)).rejects.toThrow(
      InternalServerErrorException,
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
      notesForTechnician: 'Bring ladder',
    };

    await service.createJob(owner, dto);

    expect(rpc).toHaveBeenCalledWith(
      'create_job_with_log',
      expect.objectContaining({
        p_scheduled_end: '2026-06-22T11:00:00Z',
        p_description: 'Leaky AC',
        p_priority: 'urgent',
        p_notes_for_technician: 'Bring ladder',
      }),
    );
  });

  it('toResponse trap: a row missing completed_at maps to undefined, not null', () => {
    // Pairs with the select-list assertions above: any explicit select list
    // that omits completed_at silently drops the key through the
    // `as JobRow[]` cast — undefined (not null) is the tell.
    const missingColumnRow = { ...jobRow } as Record<string, unknown>;
    delete missingColumnRow.completed_at;

    const response = service.toResponse(
      missingColumnRow as unknown as Parameters<JobsService['toResponse']>[0],
    );

    expect(response.completedAt).toBeUndefined();
  });

  it('toResponse soft read: an unreadable template embed maps to null fields, never a throw (Story 4.5)', () => {
    // Corrupt steps (unreachable under the DB validator) must not 500 a read —
    // only the advance path guards corrupt template data strictly.
    const corruptRow = {
      ...jobRow,
      workflow_templates: { version: 1, steps: 'garbage' },
    } as unknown as Parameters<JobsService['toResponse']>[0];

    const response = service.toResponse(corruptRow);

    expect(response.workflowTemplate).toBeNull();
    expect(response.currentStepIndex).toBeNull();
    // The skill embed is independent — it still maps.
    expect(response.skill).toEqual({ id: 'skill-uuid-1', name: 'Plumbing' });
  });

  it('toResponse soft read: a missing skill/template embed maps to null (Story 4.5)', () => {
    const bareRow = {
      ...jobRow,
      skills: null,
      workflow_templates: null,
    } as unknown as Parameters<JobsService['toResponse']>[0];

    const response = service.toResponse(bareRow);

    expect(response.skill).toBeNull();
    expect(response.workflowTemplate).toBeNull();
    expect(response.currentStepIndex).toBeNull();
  });

  it('toResponse maps a mid-workflow current_step to its 0-based template index (Story 4.5)', () => {
    const response = service.toResponse({
      ...jobRow,
      current_step: 'arrived',
    });

    expect(response.currentStepIndex).toBe(1);
  });

  it('toResponse maps the skill embed regardless of array shape (Story 4.5)', () => {
    const arrayEmbedRow = {
      ...jobRow,
      skills: [{ id: 'skill-uuid-1', name: 'Plumbing' }],
    } as unknown as Parameters<JobsService['toResponse']>[0];

    expect(service.toResponse(arrayEmbedRow).skill).toEqual({
      id: 'skill-uuid-1',
      name: 'Plumbing',
    });
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
      // Story 3.7 — the explicit select list must name completed_at; omitting
      // it silently drops the key through the `as JobRow[]` cast (see the
      // toResponse trap test below).
      expect(builder.select).toHaveBeenCalledWith(
        expect.stringContaining('completed_at'),
      );
      // Story 4.5 — the skill/template embeds ride the same select.
      expect(builder.select).toHaveBeenCalledWith(
        expect.stringContaining('skills(id, name)'),
      );
      expect(builder.select).toHaveBeenCalledWith(
        expect.stringContaining('workflow_templates(version, steps)'),
      );
      expect(builder.gte).toHaveBeenCalledWith(
        'scheduled_start',
        expect.any(String),
      );
      expect(builder.lt).toHaveBeenCalledWith(
        'scheduled_start',
        expect.any(String),
      );
      // Owners keep the pure day-window view — no in_progress OR branch.
      expect(builder.or).not.toHaveBeenCalled();
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
        scheduledStart: '2026-06-22T09:30:00Z',
        scheduledEnd: null,
        status: 'scheduled',
        completedAt: null,
        currentStep: null,
        priority: 'normal',
        description: null,
        notesForTechnician: null,
        createdAt: '2026-06-21T00:00:00Z',
        updatedAt: '2026-06-21T00:00:00Z',
        // Story 4.5 — every list row carries the same skill/template shape.
        skill: { id: 'skill-uuid-1', name: 'Plumbing' },
        workflowTemplate: { version: 1, steps: V1_STEPS_RESPONSE },
        currentStepIndex: null,
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
          scope: 'jobs-list',
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

    describe('timeline scopes (Story 3.7)', () => {
      // Cursor minted the way the service mints them for the scheduled_start-
      // keyed scopes: the payload field stays `createdAt` (generic keyed
      // timestamp); the scope tag carries the column semantics.
      function mintCursor(
        scope: string,
        fields: { id: string; createdAt: string },
      ): string {
        return Buffer.from(JSON.stringify({ ...fields, scope })).toString(
          'base64url',
        );
      }

      it('upcoming: start-of-tomorrow window, forced scheduled status, ASC sort', async () => {
        const { builder } = mockListAdmin({ data: [], error: null });

        await service.listJobs(owner, { scope: JobListScope.UPCOMING });

        expect(builder.eq).toHaveBeenCalledWith('tenant_id', 'tenant-uuid');
        // Start of tomorrow IST = today's range.end — no second boundary.
        expect(builder.gte).toHaveBeenCalledWith(
          'scheduled_start',
          expect.any(String),
        );
        expect(builder.lt).not.toHaveBeenCalled();
        expect(builder.eq).toHaveBeenCalledWith('status', 'scheduled');
        expect(builder.order).toHaveBeenCalledWith('scheduled_start', {
          ascending: true,
        });
        expect(builder.order).toHaveBeenCalledWith('id', { ascending: true });
      });

      it('overdue: pre-today window, scheduled+in_progress via .in(), ASC sort', async () => {
        const { builder } = mockListAdmin({ data: [], error: null });

        await service.listJobs(owner, { scope: JobListScope.OVERDUE });

        expect(builder.lt).toHaveBeenCalledWith(
          'scheduled_start',
          expect.any(String),
        );
        expect(builder.gte).not.toHaveBeenCalled();
        // .in — never .not.in (a chained .not.in throws at runtime on postgrest-js).
        expect(builder.in).toHaveBeenCalledWith('status', [
          'scheduled',
          'in_progress',
        ]);
        expect(builder.order).toHaveBeenCalledWith('scheduled_start', {
          ascending: true,
        });
        expect(builder.order).toHaveBeenCalledWith('id', { ascending: true });
      });

      it('history: completed+cancelled only, most recent planned date first', async () => {
        const { builder } = mockListAdmin({ data: [], error: null });

        await service.listJobs(owner, { scope: JobListScope.HISTORY });

        expect(builder.in).toHaveBeenCalledWith('status', [
          'completed',
          'cancelled',
        ]);
        expect(builder.gte).not.toHaveBeenCalled();
        expect(builder.lt).not.toHaveBeenCalled();
        expect(builder.order).toHaveBeenCalledWith('scheduled_start', {
          ascending: false,
        });
        expect(builder.order).toHaveBeenCalledWith('id', { ascending: false });
      });

      it('caller status filter intersects with the scope statuses (no special-casing)', async () => {
        const { builder } = mockListAdmin({ data: [], error: null });

        await service.listJobs(owner, {
          scope: JobListScope.HISTORY,
          status: [JobStatus.COMPLETED],
        });

        // Both the scope's forced set and the caller's filter are applied —
        // the DB intersect gives a legitimately (possibly) empty page.
        expect(builder.in).toHaveBeenCalledWith('status', [
          'completed',
          'cancelled',
        ]);
        expect(builder.in).toHaveBeenCalledWith('status', ['completed']);
      });

      it('today + technician: ORs the day window with their in_progress jobs', async () => {
        const { builder } = mockListAdmin({ data: [], error: null });
        const tech: RequestUser = {
          userId: 'tech-self',
          tenantId: 'tenant-uuid',
          role: Role.TECHNICIAN,
          rawJwt: 'jwt',
        };

        await service.listJobs(tech, {});

        // The in_progress OR branch is not tenant-wide — the technician_id
        // self-scope (ANDed by postgrest-js) narrows it to their own jobs.
        expect(builder.eq).toHaveBeenCalledWith('technician_id', 'tech-self');
        expect(builder.or).toHaveBeenCalledWith(
          expect.stringMatching(
            /^and\(scheduled_start\.gte\..+,scheduled_start\.lt\..+\),status\.eq\.in_progress$/,
          ),
        );
      });

      it('today + technician + explicit date: keeps the pure day window (no in_progress OR)', async () => {
        const { builder } = mockListAdmin({ data: [], error: null });
        const tech: RequestUser = {
          userId: 'tech-self',
          tenantId: 'tenant-uuid',
          role: Role.TECHNICIAN,
          rawJwt: 'jwt',
        };

        await service.listJobs(tech, { date: '2026-09-08' });

        // A date re-anchor is a day-history view — in_progress jobs from other
        // days must not leak in.
        expect(builder.or).not.toHaveBeenCalled();
        expect(builder.gte).toHaveBeenCalledWith(
          'scheduled_start',
          expect.any(String),
        );
        expect(builder.lt).toHaveBeenCalledWith(
          'scheduled_start',
          expect.any(String),
        );
      });

      it('non-today scopes for a technician: no in_progress OR branch', async () => {
        for (const scope of [
          JobListScope.UPCOMING,
          JobListScope.OVERDUE,
          JobListScope.HISTORY,
        ]) {
          const { builder } = mockListAdmin({ data: [], error: null });
          const tech: RequestUser = {
            userId: 'tech-self',
            tenantId: 'tenant-uuid',
            role: Role.TECHNICIAN,
            rawJwt: 'jwt',
          };

          await service.listJobs(tech, { scope });

          expect(builder.or).not.toHaveBeenCalled();
        }
      });

      it('applies the technician self-scope in non-today scopes too', async () => {
        const { builder } = mockListAdmin({ data: [], error: null });
        const tech: RequestUser = {
          userId: 'tech-self',
          tenantId: 'tenant-uuid',
          role: Role.TECHNICIAN,
          rawJwt: 'jwt',
        };

        await service.listJobs(tech, { scope: JobListScope.UPCOMING });

        expect(builder.eq).toHaveBeenCalledWith('technician_id', 'tech-self');
      });

      it('paginates upcoming with an ASC keyset cursor on (scheduled_start, id)', async () => {
        const { builder } = mockListAdmin({ data: [], error: null });
        const cursor = mintCursor('jobs-upcoming', {
          id: '22222222-2222-4222-8222-222222222222',
          createdAt: '2026-06-23T09:30:00.000Z',
        });

        await service.listJobs(owner, { scope: JobListScope.UPCOMING, cursor });

        expect(builder.or).toHaveBeenCalledWith(
          'scheduled_start.gt.2026-06-23T09:30:00.000Z,' +
            'and(scheduled_start.eq.2026-06-23T09:30:00.000Z,' +
            'id.gt.22222222-2222-4222-8222-222222222222)',
        );
      });

      it('paginates history with a DESC keyset cursor on (scheduled_start, id)', async () => {
        const { builder } = mockListAdmin({ data: [], error: null });
        const cursor = mintCursor('jobs-history', {
          id: '33333333-3333-4333-8333-333333333333',
          createdAt: '2026-06-23T09:30:00.000Z',
        });

        await service.listJobs(owner, { scope: JobListScope.HISTORY, cursor });

        expect(builder.or).toHaveBeenCalledWith(
          'scheduled_start.lt.2026-06-23T09:30:00.000Z,' +
            'and(scheduled_start.eq.2026-06-23T09:30:00.000Z,' +
            'id.lt.33333333-3333-4333-8333-333333333333)',
        );
      });

      it('mints the next cursor from scheduled_start under the matching scope', async () => {
        const rows = Array.from({ length: 51 }, (_, i) => ({
          ...jobRow,
          id: `job-${i}`,
          scheduled_start: `2026-06-2${Math.floor(i / 10)}T0${i % 10}:00:00Z`,
        }));
        mockListAdmin({ data: rows, error: null });

        const result = await service.listJobs(owner, {
          scope: JobListScope.HISTORY,
        });

        expect(result.hasMore).toBe(true);
        const decoded = JSON.parse(
          Buffer.from(result.nextCursor as string, 'base64url').toString(
            'utf-8',
          ),
        ) as { id: string; createdAt: string; scope: string };
        expect(decoded.id).toBe('job-49');
        expect(decoded.createdAt).toBe(rows[49].scheduled_start);
        expect(decoded.scope).toBe('jobs-history');
      });

      it.each([
        [
          'jobs-list cursor against upcoming',
          JobListScope.UPCOMING,
          'jobs-list',
        ],
        [
          'jobs-upcoming cursor against today',
          JobListScope.TODAY,
          'jobs-upcoming',
        ],
        [
          'jobs-history cursor against overdue',
          JobListScope.OVERDUE,
          'jobs-history',
        ],
      ])('rejects a %s with 400', async (_label, scope, cursorScope) => {
        mockListAdmin({ data: [], error: null });
        const cursor = mintCursor(cursorScope, {
          id: '44444444-4444-4444-8444-444444444444',
          createdAt: '2026-06-23T09:30:00.000Z',
        });

        await expectStatus(
          service.listJobs(owner, { scope, cursor }),
          HttpStatus.BAD_REQUEST,
        );
      });
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
      latitude: 18.5204,
      longitude: 73.8567,
    };
    const skillRows = [
      { skills: { name: 'AC Repair' } },
      { skills: { name: 'Plumbing' } },
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
      // user_skills chains ONE eq call since Story 4.2: .eq('user_id') — the
      // global skills catalog carries no tenant to filter on.
      const skillsEq1 = jest
        .fn()
        .mockResolvedValue(opts.skills ?? { data: skillRows, error: null });
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
        latitude: 18.5204,
        longitude: 73.8567,
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
      // Story 3.7 — completedAt rides on the detail response too (null for an
      // uncompleted job; the select-list trap is covered separately).
      expect(result.completedAt).toBeNull();
    });

    it('selects latitude/longitude from customers and maps them onto the detail response (Story 2.1)', async () => {
      const { from, chains } = mockDetailAdmin({});

      const result = await service.getJobDetail(owner, 'job-uuid');

      // The coordinates must ride the same single customers read, not a second
      // query — exactly one customers fetch, requesting the exact column list.
      expect(
        from.mock.calls.filter(([table]) => table === 'customers'),
      ).toHaveLength(1);
      expect(chains.customers.select).toHaveBeenCalledWith(
        'id, name, country_code, phone_number, address, city, latitude, longitude',
      );
      expect(result.customer.latitude).toBe(18.5204);
      expect(result.customer.longitude).toBe(73.8567);
    });

    it('returns null latitude/longitude for a customer saved without coordinates (Story 2.1)', async () => {
      mockDetailAdmin({
        customer: {
          data: {
            id: 'cust-1',
            name: 'Priya',
            country_code: '+91',
            phone_number: '9876543210',
            address: '12 MG Road',
            city: 'Pune',
            latitude: null,
            longitude: null,
          },
          error: null,
        },
      });

      const result = await service.getJobDetail(owner, 'job-uuid');

      // Fields are independently null — never fabricated, never omitted.
      expect(result.customer).toEqual({
        id: 'cust-1',
        name: 'Priya',
        countryCode: '+91',
        phoneNumber: '9876543210',
        address: '12 MG Road',
        city: 'Pune',
        latitude: null,
        longitude: null,
      });
    });

    it('passes through partial coordinates without fabricating the missing one (Story 2.1)', async () => {
      mockDetailAdmin({
        customer: {
          data: {
            id: 'cust-1',
            name: 'Priya',
            country_code: '+91',
            phone_number: '9876543210',
            address: '12 MG Road',
            city: 'Pune',
            latitude: 18.5204,
            longitude: null,
          },
          error: null,
        },
      });

      const result = await service.getJobDetail(owner, 'job-uuid');

      // Each field maps independently — no cross-field null-out.
      expect(result.customer.latitude).toBe(18.5204);
      expect(result.customer.longitude).toBeNull();
    });

    it('selects completed_at and maps a completed job onto the detail response', async () => {
      const { chains } = mockDetailAdmin({
        job: {
          data: {
            ...jobRow,
            status: 'completed',
            completed_at: '2026-06-23T05:00:00Z',
          },
          error: null,
        },
      });

      const result = await service.getJobDetail(owner, 'job-uuid');

      expect(chains.jobs.select).toHaveBeenCalledWith(
        expect.stringContaining('completed_at'),
      );
      expect(result.completedAt).toBe('2026-06-23T05:00:00Z');
    });

    it('selects the skill/template embeds and maps them onto the detail response (Story 4.5)', async () => {
      const { chains } = mockDetailAdmin({
        job: { data: { ...jobRow, current_step: 'arrived' }, error: null },
      });

      const result = await service.getJobDetail(owner, 'job-uuid');

      expect(chains.jobs.select).toHaveBeenCalledWith(
        expect.stringContaining('skills(id, name)'),
      );
      expect(chains.jobs.select).toHaveBeenCalledWith(
        expect.stringContaining('workflow_templates(version, steps)'),
      );
      expect(result.skill).toEqual({ id: 'skill-uuid-1', name: 'Plumbing' });
      expect(result.workflowTemplate).toEqual({
        version: 1,
        steps: V1_STEPS_RESPONSE,
      });
      // Mid-workflow: current_step = steps[1] → 0-based index 1.
      expect(result.currentStepIndex).toBe(1);
    });

    it('still returns the skill name when the skill has been archived (soft read, Story 4.5)', async () => {
      // The read surface uses a PLAIN left embed — no `!inner` and no
      // is_active filter — so an archived/inactive skill's name keeps
      // flowing to job reads (the frozen I/O matrix's soft-read row):
      // the job is never dropped from a list and a detail read never 404s
      // over an inactive skill.
      const { chains } = mockDetailAdmin({
        job: {
          data: {
            ...jobRow,
            current_step: null,
            skills: { id: 'skill-uuid-1', name: 'Plumbing (archived)' },
          },
          error: null,
        },
      });

      const result = await service.getJobDetail(owner, 'job-uuid');

      expect(chains.jobs.select).toHaveBeenCalledWith(
        expect.not.stringContaining('!inner'),
      );
      expect(result.skill).toEqual({
        id: 'skill-uuid-1',
        name: 'Plumbing (archived)',
      });
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

    it('allows a technician to view their own assigned job with the full customer profile (Story 2.1 follow-up)', async () => {
      mockDetailAdmin({});

      const result = await service.getJobDetail(techOwn, 'job-uuid');

      expect(result.id).toBe('job-uuid');
      // Same shared mapping path as the owner's — assert it fully so a
      // customer-mapping regression can't slip past the technician role.
      expect(result.customer).toEqual({
        id: 'cust-1',
        name: 'Priya',
        countryCode: '+91',
        phoneNumber: '9876543210',
        address: '12 MG Road',
        city: 'Pune',
        latitude: 18.5204,
        longitude: 73.8567,
      });
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
      // skills: global catalog since Story 4.2 — only the technician filter,
      // no tenant scope (the technician read above is the tenant guard)
      expect(m.skillsEq1).toHaveBeenCalledWith('user_id', 'tech-1');
      // activity_logs: .eq('job_id', jobId).eq('tenant_id', tenantId)
      expect(m.logEq1).toHaveBeenCalledWith('job_id', 'job-uuid');
      expect(m.logEq2).toHaveBeenCalledWith('tenant_id', 'tenant-uuid');
    });

    it('normalizes both PostgREST embed shapes and drops empty skill names', async () => {
      mockDetailAdmin({
        skills: {
          data: [
            { skills: [{ name: 'AC Repair' }, { name: 'Plumbing' }] }, // array shape
            { skills: { name: 'Wiring' } }, // object shape
            { skills: null }, // no skill
            { skills: { name: '' } }, // empty name → dropped
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
      // Story 4.4 — the flags are gone: the update RPC carries no flag params.
      const rpcArgs = rpc.mock.calls[0][1] as Record<string, unknown>;
      expect(rpcArgs).not.toHaveProperty('p_require_completion_photo');
      expect(rpcArgs).not.toHaveProperty('p_require_completion_signature');
    });

    it('maps the stamped skill + template + currentStepIndex through the post-RPC embed re-fetch (Story 4.5)', async () => {
      // The RPC row is bare (write RPCs return plain job rows — no embeds);
      // the re-fetch supplies them. Mirrors the create-route tests.
      const bareRpcRow = {
        ...jobRow,
        description: 'edited',
        skill_id: undefined,
        skills: undefined,
        workflow_templates: undefined,
      };
      mockAdmin({
        rpc: { data: [bareRpcRow], error: null },
        refetch: { data: { ...jobRow, description: 'edited' }, error: null },
      });

      const result = await service.updateJob(owner, 'job-uuid', {
        description: 'edited',
        priority: JobPriority.URGENT,
      });

      expect(result.description).toBe('edited');
      expect(result.skill).toEqual({ id: 'skill-uuid-1', name: 'Plumbing' });
      expect(result.workflowTemplate).toEqual({
        version: 1,
        steps: V1_STEPS_RESPONSE,
      });
      // Fresh job (current_step null) → null index, full steps list present.
      expect(result.currentStepIndex).toBeNull();
      expect(result.workflowTemplate?.steps).toHaveLength(6);
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
