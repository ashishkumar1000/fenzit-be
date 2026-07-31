import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { CustomersService } from '../customers/customers.service';
import { JobsService } from '../jobs/jobs.service';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import { PaginatedResponse } from '../common/dto/paginated-response.dto';
import { encodeCursor } from '../common/utils/cursor.util';

type DbResult = { data: unknown; error: unknown };

interface CountBuilder {
  eq: jest.Mock;
  technicianIdArg: string | undefined;
  then: (resolve: (v: unknown) => void) => void;
}

describe('UsersService', () => {
  let service: UsersService;
  let supabaseClientFactory: jest.Mocked<SupabaseClientFactory>;
  let customersService: { listCustomers: jest.Mock };
  let jobsService: { toResponse: jest.Mock };

  const ownerUser: RequestUser = {
    userId: 'owner-uuid',
    tenantId: 'tenant-uuid',
    role: Role.OWNER,
    rawJwt: 'jwt',
  };

  const technicianUser: RequestUser = {
    userId: 'tech-uuid',
    tenantId: 'tenant-uuid',
    role: Role.TECHNICIAN,
    rawJwt: 'jwt',
  };

  const ownOwnerRow = {
    id: 'owner-uuid',
    name: 'Ashish',
    country_code: '+91',
    phone_number: '9000000000',
    role: 'owner',
    status: 'active',
    tenant_id: 'tenant-uuid',
  };

  const ownTechnicianRow = {
    id: 'tech-uuid',
    name: 'Ravi',
    country_code: '+91',
    phone_number: '9111111111',
    role: 'technician',
    status: 'active',
    tenant_id: 'tenant-uuid',
  };

  const tenantRow = {
    id: 'tenant-uuid',
    company_name: 'Acme Services',
    gstin: null,
    address: '12 MG Road',
    state_code: 'MH',
    service_categories: ['plumbing'],
    upi_vpa: null,
  };

  const technicianListRows = [
    {
      id: 'tech-uuid',
      name: 'Ravi',
      country_code: '+91',
      phone_number: '9111111111',
      status: 'active',
      created_at: '2026-06-01T00:00:00Z',
      // one row uses the object embed shape, one uses the array embed shape —
      // exercises both normalization branches in flattenSkillNames.
      user_skills: [
        { tenant_skills: { name: 'Plumbing' } },
        { tenant_skills: [{ name: 'Electrical' }, { name: 'Wiring' }] },
      ],
    },
  ];

  const ownSkillsRows = [
    { tenant_skills: { name: 'AC Repair' } },
    { tenant_skills: [{ name: 'Pest Control' }] },
  ];

  const emptyCustomersPage = new PaginatedResponse([], null);

  function jobRow(id: string, status: string, createdAt: string) {
    return {
      id,
      job_number: `JB-${id}`,
      tenant_id: 'tenant-uuid',
      customer_id: 'cust-1',
      technician_id: 'tech-uuid',
      service_location: 'Loc',
      service_type: 'plumbing',
      scheduled_start: createdAt,
      scheduled_end: null,
      status,
      current_step: null,
      priority: 'normal',
      require_completion_photo: false,
      description: null,
      notes_for_technician: null,
      created_at: createdAt,
      updated_at: createdAt,
    };
  }

  beforeEach(async () => {
    const mockFactory = { create: jest.fn(), createAdmin: jest.fn() };
    customersService = {
      listCustomers: jest.fn().mockResolvedValue(emptyCustomersPage),
    };
    jobsService = {
      // Deliberately minimal — jobs.service.spec.ts already covers the real
      // row→camelCase mapping; here we only need something identifiable so
      // this test can assert the profile endpoint wired the right rows through.
      toResponse: jest.fn((row: { id: string; status: string }) => ({
        id: row.id,
        status: row.status,
      })),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: SupabaseClientFactory, useValue: mockFactory },
        { provide: CustomersService, useValue: customersService },
        { provide: JobsService, useValue: jobsService },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
    supabaseClientFactory = module.get(SupabaseClientFactory);
  });

  // ---- per-table mock builders, mirroring the exact chains in users.service.ts ----

  // users.eq('id',...).single() (own profile) vs
  // users.eq('tenant_id',...).eq('role',...).order(...) (owner's technician list)
  // — dispatched on whether the select() column list mentions user_skills.
  function usersTableHandler(ownResult: DbResult, techniciansResult: DbResult) {
    const select = jest.fn((cols: string) => {
      if (cols.includes('user_skills')) {
        const order = jest.fn().mockResolvedValue(techniciansResult);
        const eqRole = jest.fn().mockReturnValue({ order });
        const eqTenant = jest.fn().mockReturnValue({ eq: eqRole });
        return { eq: eqTenant };
      }
      const single = jest.fn().mockResolvedValue(ownResult);
      const eqId = jest.fn().mockReturnValue({ single });
      return { eq: eqId };
    });
    return { select };
  }

  function tenantsTableHandler(result: DbResult) {
    const single = jest.fn().mockResolvedValue(result);
    const eq = jest.fn().mockReturnValue({ single });
    return { select: jest.fn().mockReturnValue({ eq }) };
  }

  function userSkillsTableHandler(result: DbResult) {
    const eq2 = jest.fn().mockResolvedValue(result);
    const eq1 = jest.fn().mockReturnValue({ eq: eq2 });
    return { select: jest.fn().mockReturnValue({ eq: eq1 }) };
  }

  // jobs.select(JOB_COLUMNS)...limit() (list) vs
  // jobs.select('*', {count:'exact',head:true}).eq(...).eq('status',...) (count,
  // awaited directly — no .single()/.limit() terminal, so the builder itself
  // must be thenable). Dispatched on whether select()'s 2nd arg has head:true.
  function jobsTableHandler(
    listResult: DbResult,
    countsByStatus: Record<string, number> | { error: unknown },
    countBuilders: CountBuilder[],
    listBuilders: Array<Record<string, jest.Mock>>,
  ) {
    const select = jest.fn(
      (_cols: string, opts?: { count?: string; head?: boolean }) => {
        if (opts?.head) {
          let status: string | undefined;
          const builder: CountBuilder = {
            eq: jest.fn((col: string, val: string) => {
              if (col === 'status') status = val;
              if (col === 'technician_id') builder.technicianIdArg = val;
              return builder;
            }),
            technicianIdArg: undefined,
            then: (resolve: (v: unknown) => void) => {
              if (countsByStatus && 'error' in countsByStatus) {
                resolve({
                  data: null,
                  error: countsByStatus.error,
                  count: null,
                });
              } else {
                const count = countsByStatus[status as string] ?? 0;
                resolve({ data: null, error: null, count });
              }
            },
          };
          countBuilders.push(builder);
          return builder;
        }

        const builder: Record<string, jest.Mock> = {};
        for (const m of ['eq', 'or', 'order']) {
          builder[m] = jest.fn().mockReturnValue(builder);
        }
        builder.limit = jest.fn().mockResolvedValue(listResult);
        listBuilders.push(builder);
        return builder;
      },
    );
    return { select };
  }

  function mockAdmin(opts: {
    ownRow?: DbResult;
    tenant?: DbResult;
    technicians?: DbResult;
    ownSkills?: DbResult;
    jobsList?: DbResult;
    jobCounts?: Record<string, number> | { error: unknown };
  }) {
    const ownRow = opts.ownRow ?? { data: ownOwnerRow, error: null };
    const tenant = opts.tenant ?? { data: tenantRow, error: null };
    const technicians = opts.technicians ?? { data: [], error: null };
    const ownSkills = opts.ownSkills ?? { data: [], error: null };
    const jobsList = opts.jobsList ?? { data: [], error: null };
    const jobCounts = opts.jobCounts ?? {
      scheduled: 0,
      in_progress: 0,
      completed: 0,
      cancelled: 0,
    };

    const countBuilders: CountBuilder[] = [];
    const listBuilders: Array<Record<string, jest.Mock>> = [];

    const from = jest.fn((table: string) => {
      if (table === 'users') return usersTableHandler(ownRow, technicians);
      if (table === 'tenants') return tenantsTableHandler(tenant);
      if (table === 'user_skills') return userSkillsTableHandler(ownSkills);
      if (table === 'jobs') {
        return jobsTableHandler(
          jobsList,
          jobCounts,
          countBuilders,
          listBuilders,
        );
      }
      throw new Error(`unexpected table ${table}`);
    });

    supabaseClientFactory.createAdmin.mockReturnValue({ from } as never);
    return { from, countBuilders, listBuilders };
  }

  describe('getMyProfile — owner', () => {
    it('returns the full owner profile: tenant, technicians, technicianCount, customers, jobs, jobStatusCounts', async () => {
      mockAdmin({
        technicians: { data: technicianListRows, error: null },
        jobsList: {
          data: [jobRow('j1', 'scheduled', '2026-06-21T00:00:00Z')],
          error: null,
        },
        jobCounts: { scheduled: 3, in_progress: 1, completed: 5, cancelled: 0 },
      });
      customersService.listCustomers.mockResolvedValue(emptyCustomersPage);

      const result = await service.getMyProfile(ownerUser, {});

      expect(result.role).toBe(Role.OWNER);
      expect(result.id).toBe('owner-uuid');
      expect(result.name).toBe('Ashish');
      expect(result.tenant).toEqual({
        id: 'tenant-uuid',
        companyName: 'Acme Services',
        gstin: null,
        address: '12 MG Road',
        stateCode: 'MH',
        serviceCategories: ['plumbing'],
        upiVpa: null,
      });
      if (result.role !== Role.OWNER) throw new Error('expected owner shape');
      expect(result.technicianCount).toBe(1);
      expect(result.technicians[0].skills.sort()).toEqual(
        ['Plumbing', 'Electrical', 'Wiring'].sort(),
      );
      expect(result.customers).toBe(emptyCustomersPage);
      expect(result.jobs.data).toEqual([{ id: 'j1', status: 'scheduled' }]);
      expect(result.jobStatusCounts).toEqual({
        scheduled: 3,
        inProgress: 1,
        completed: 5,
        cancelled: 0,
      });
    });

    it('passes the DB-fresh tenantId (not a possibly-stale JWT claim) into customersService.listCustomers', async () => {
      // Simulate a stale JWT: the token's tenantId claim is null, but the DB
      // row (fetched fresh inside getMyProfile) already has a tenant set.
      mockAdmin({});
      const staleOwner: RequestUser = { ...ownerUser, tenantId: null };

      await service.getMyProfile(staleOwner, {});

      expect(customersService.listCustomers).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-uuid' }),
        expect.anything(),
      );
    });

    it('forwards customersCursor to customersService.listCustomers', async () => {
      mockAdmin({});

      await service.getMyProfile(ownerUser, { customersCursor: 'abc' });

      expect(customersService.listCustomers).toHaveBeenCalledWith(
        expect.anything(),
        { cursor: 'abc' },
      );
    });

    it('does not scope jobs or job counts to any single technician', async () => {
      const { countBuilders, listBuilders } = mockAdmin({});

      await service.getMyProfile(ownerUser, {});

      for (const b of listBuilders) {
        expect(b.eq).not.toHaveBeenCalledWith(
          'technician_id',
          expect.anything(),
        );
      }
      for (const b of countBuilders) {
        expect(b.technicianIdArg).toBeUndefined();
      }
    });

    it('applies a valid jobsCursor as a keyset filter on the jobs list query', async () => {
      const { listBuilders } = mockAdmin({});
      const cursor = encodeCursor(
        '11111111-1111-4111-8111-111111111111',
        '2026-06-21T00:00:00.000Z',
      );

      await service.getMyProfile(ownerUser, { jobsCursor: cursor });

      expect(listBuilders[0].or).toHaveBeenCalledWith(
        'created_at.lt.2026-06-21T00:00:00.000Z,' +
          'and(created_at.eq.2026-06-21T00:00:00.000Z,' +
          'id.lt.11111111-1111-4111-8111-111111111111)',
      );
    });

    it('throws 400 on a malformed jobsCursor', async () => {
      mockAdmin({});

      await expect(
        service.getMyProfile(ownerUser, { jobsCursor: 'not-a-valid-cursor' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('returns a minimal profile pre-onboarding (tenant_id null) without touching tenant/technicians/jobs/customers', async () => {
      const { from } = mockAdmin({
        ownRow: { data: { ...ownOwnerRow, tenant_id: null }, error: null },
      });

      const result = await service.getMyProfile(ownerUser, {});

      expect(result.tenant).toBeNull();
      if (result.role !== Role.OWNER) throw new Error('expected owner shape');
      expect(result.technicians).toEqual([]);
      expect(result.technicianCount).toBe(0);
      expect(result.customers).toEqual({
        data: [],
        nextCursor: null,
        hasMore: false,
      });
      expect(result.jobs).toEqual({
        data: [],
        nextCursor: null,
        hasMore: false,
      });
      expect(result.jobStatusCounts).toEqual({
        scheduled: 0,
        inProgress: 0,
        completed: 0,
        cancelled: 0,
      });
      // only the own-profile lookup should have run
      expect(from).toHaveBeenCalledTimes(1);
      expect(from).toHaveBeenCalledWith('users');
      expect(customersService.listCustomers).not.toHaveBeenCalled();
    });

    it('throws 500 when the own-profile fetch errors', async () => {
      mockAdmin({ ownRow: { data: null, error: { code: '08006' } } });

      await expect(service.getMyProfile(ownerUser, {})).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('throws 500 when the tenant fetch errors', async () => {
      mockAdmin({ tenant: { data: null, error: { code: '08006' } } });

      await expect(service.getMyProfile(ownerUser, {})).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('throws 500 when the technician list query errors', async () => {
      mockAdmin({ technicians: { data: null, error: { code: '08006' } } });

      await expect(service.getMyProfile(ownerUser, {})).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('throws 500 when the jobs list query errors', async () => {
      mockAdmin({ jobsList: { data: null, error: { code: '08006' } } });

      await expect(service.getMyProfile(ownerUser, {})).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('throws 500 when a job status count query errors', async () => {
      mockAdmin({ jobCounts: { error: { code: '08006' } } });

      await expect(service.getMyProfile(ownerUser, {})).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('getMyProfile — technician', () => {
    it('returns the technician profile: own skills, own jobs, own jobStatusCounts', async () => {
      mockAdmin({
        ownRow: { data: ownTechnicianRow, error: null },
        ownSkills: { data: ownSkillsRows, error: null },
        jobsList: {
          data: [jobRow('j2', 'in_progress', '2026-06-21T00:00:00Z')],
          error: null,
        },
        jobCounts: { scheduled: 1, in_progress: 2, completed: 0, cancelled: 0 },
      });

      const result = await service.getMyProfile(technicianUser, {});

      expect(result.role).toBe(Role.TECHNICIAN);
      if (result.role !== Role.TECHNICIAN)
        throw new Error('expected technician shape');
      expect(result.skills.sort()).toEqual(
        ['AC Repair', 'Pest Control'].sort(),
      );
      expect(result.jobs.data).toEqual([{ id: 'j2', status: 'in_progress' }]);
      expect(result.jobStatusCounts).toEqual({
        scheduled: 1,
        inProgress: 2,
        completed: 0,
        cancelled: 0,
      });
    });

    it('scopes both the jobs list and job status counts to the caller only', async () => {
      const { countBuilders, listBuilders } = mockAdmin({
        ownRow: { data: ownTechnicianRow, error: null },
      });

      await service.getMyProfile(technicianUser, {});

      expect(listBuilders[0].eq).toHaveBeenCalledWith(
        'technician_id',
        'tech-uuid',
      );
      for (const b of countBuilders) {
        expect(b.technicianIdArg).toBe('tech-uuid');
      }
    });

    it('never queries technicians or customers for a technician caller', async () => {
      mockAdmin({ ownRow: { data: ownTechnicianRow, error: null } });

      await service.getMyProfile(technicianUser, {});

      expect(customersService.listCustomers).not.toHaveBeenCalled();
    });

    it('returns a minimal profile pre-onboarding (tenant_id null)', async () => {
      mockAdmin({
        ownRow: { data: { ...ownTechnicianRow, tenant_id: null }, error: null },
      });

      const result = await service.getMyProfile(technicianUser, {});

      expect(result.tenant).toBeNull();
      if (result.role !== Role.TECHNICIAN)
        throw new Error('expected technician shape');
      expect(result.skills).toEqual([]);
      expect(result.jobs).toEqual({
        data: [],
        nextCursor: null,
        hasMore: false,
      });
    });

    it('throws 500 when the own-skills query errors', async () => {
      mockAdmin({
        ownRow: { data: ownTechnicianRow, error: null },
        ownSkills: { data: null, error: { code: '08006' } },
      });

      await expect(service.getMyProfile(technicianUser, {})).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });
});
