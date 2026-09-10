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
import { encodeCursor, decodeCursor } from '../common/utils/cursor.util';
import { getIstDayRange } from '../common/utils/ist-day-range.util';
import { JobStatus } from '../jobs/enums/job-status.enum';

type DbResult = { data: unknown; error: unknown };

// getJobCounts issues FIVE head:true, count:'exact' queries in a fixed order
// (today, upcoming, overdue, completed, cancelled — Story 3.7). The mock keys
// resolved counts on that call order and records every builder call so tests
// can assert the predicates (gte/lt windows, forced status sets, tech scoping).
interface CountBuilder {
  eq: jest.Mock;
  gte: jest.Mock;
  lt: jest.Mock;
  in: jest.Mock;
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
        { skills: { name: 'Plumbing' } },
        { skills: [{ name: 'Electrical' }, { name: 'Wiring' }] },
      ],
    },
  ];

  const ownSkillsRows = [
    { skills: { name: 'AC Repair' } },
    { skills: [{ name: 'Pest Control' }] },
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
      completed_at: null,
      current_step: null,
      priority: 'normal',
      require_completion_photo: false,
      require_completion_signature: false,
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
  // vs users.in('id', ids).eq('tenant_id',...) (Story 3.9 batched embed fetch)
  // — dispatched on whether the select() column list mentions user_skills.
  function usersTableHandler(
    ownResult: DbResult,
    techniciansResult: DbResult,
    batchUsersResult: DbResult,
  ) {
    const batchUsersEq = jest.fn().mockResolvedValue(batchUsersResult);
    const select = jest.fn((cols: string) => {
      if (cols.includes('user_skills')) {
        const order = jest.fn().mockResolvedValue(techniciansResult);
        const eqRole = jest.fn().mockReturnValue({ order });
        const eqTenant = jest.fn().mockReturnValue({ eq: eqRole });
        return { eq: eqTenant };
      }
      const single = jest.fn().mockResolvedValue(ownResult);
      const eqId = jest.fn().mockReturnValue({ single });
      const inIds = jest.fn().mockReturnValue({ eq: batchUsersEq });
      return { eq: eqId, in: inIds };
    });
    return { select, batchUsersEq };
  }

  // customers.eq('tenant_id',...).in('id', ids) — Story 3.9 batched embed fetch.
  function customersTableHandler(result: DbResult) {
    const inIds = jest.fn().mockResolvedValue(result);
    const eqTenant = jest.fn().mockReturnValue({ in: inIds });
    return {
      select: jest.fn().mockReturnValue({ eq: eqTenant }),
      inIds,
      eqTenant,
    };
  }

  function tenantsTableHandler(result: DbResult) {
    const single = jest.fn().mockResolvedValue(result);
    const eq = jest.fn().mockReturnValue({ single });
    return { select: jest.fn().mockReturnValue({ eq }) };
  }

  // user_skills.eq('user_id',...) (own skills)
  // vs user_skills.in('user_id', ids) (Story 3.9 batched embed skills,
  // awaited at .in() — Story 4.2 removed the tenant_skills tenant filter)
  // — dispatched on the select column list.
  function userSkillsTableHandler(ownResult: DbResult, batchResult: DbResult) {
    const select = jest.fn((cols: string) => {
      if (cols.includes('user_id')) {
        const inFn = jest.fn().mockResolvedValue(batchResult);
        return { in: inFn };
      }
      const eq1 = jest.fn().mockResolvedValue(ownResult);
      return { eq: eq1 };
    });
    return { select };
  }

  // jobs.select(JOB_COLUMNS)...limit() (list) vs
  // jobs.select('*', {count:'exact',head:true}).eq(...).gte(...).lt(...).in(...)
  // (count, awaited directly — no .single()/.limit() terminal, so the builder
  // itself must be thenable). Dispatched on whether select()'s 2nd arg has
  // head:true. Counts resolve by call order against the JobCounts keys.
  function jobsTableHandler(
    listResult: DbResult,
    counts: Record<string, number> | { error: unknown },
    countBuilders: CountBuilder[],
    listBuilders: Array<Record<string, jest.Mock>>,
  ) {
    const COUNT_KEYS = [
      'today',
      'upcoming',
      'overdue',
      'completed',
      'cancelled',
    ];
    const select = jest.fn(
      (_cols: string, opts?: { count?: string; head?: boolean }) => {
        if (opts?.head) {
          const index = countBuilders.length;
          const builder = {} as CountBuilder;
          builder.eq = jest.fn((col: string, val: string) => {
            if (col === 'technician_id') builder.technicianIdArg = val;
            return builder;
          });
          builder.gte = jest.fn(() => builder);
          builder.lt = jest.fn(() => builder);
          builder.in = jest.fn(() => builder);
          builder.technicianIdArg = undefined;
          builder.then = (resolve: (v: unknown) => void) => {
            if (counts && 'error' in counts) {
              resolve({
                data: null,
                error: counts.error,
                count: null,
              });
            } else {
              resolve({
                data: null,
                error: null,
                count: counts[COUNT_KEYS[index]] ?? 0,
              });
            }
          };
          countBuilders.push(builder);
          return builder;
        }

        const builder: Record<string, jest.Mock> = {};
        for (const m of ['eq', 'or', 'order', 'gte', 'lt']) {
          builder[m] = jest.fn().mockReturnValue(builder);
        }
        builder.limit = jest.fn().mockResolvedValue(listResult);
        // Select-column list is recorded so tests can assert the profile's
        // explicit select list still names completed_at (Story 3.7).
        (builder as unknown as { selectCols: string }).selectCols = _cols;
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
    batchUsers?: DbResult;
    batchSkills?: DbResult;
    batchCustomers?: DbResult;
  }) {
    const ownRow = opts.ownRow ?? { data: ownOwnerRow, error: null };
    const tenant = opts.tenant ?? { data: tenantRow, error: null };
    const technicians = opts.technicians ?? { data: [], error: null };
    const ownSkills = opts.ownSkills ?? { data: [], error: null };
    const jobsList = opts.jobsList ?? { data: [], error: null };
    const jobCounts = opts.jobCounts ?? {
      today: 0,
      upcoming: 0,
      overdue: 0,
      completed: 0,
      cancelled: 0,
    };
    // Story 3.9 batched embed fetches — only hit when the jobs page is
    // non-empty.
    const batchUsers = opts.batchUsers ?? { data: [], error: null };
    const batchSkills = opts.batchSkills ?? { data: [], error: null };
    const batchCustomers = opts.batchCustomers ?? { data: [], error: null };

    const countBuilders: CountBuilder[] = [];
    const listBuilders: Array<Record<string, jest.Mock>> = [];

    const usersHandler = usersTableHandler(ownRow, technicians, batchUsers);
    const skillsHandler = userSkillsTableHandler(ownSkills, batchSkills);
    const customersHandler = customersTableHandler(batchCustomers);

    const from = jest.fn((table: string) => {
      if (table === 'users') return usersHandler;
      if (table === 'tenants') return tenantsTableHandler(tenant);
      if (table === 'user_skills') return skillsHandler;
      if (table === 'customers') return customersHandler;
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
    return {
      from,
      countBuilders,
      listBuilders,
      usersHandler,
      skillsHandler,
      customersHandler,
    };
  }

  describe('getMyProfile — owner', () => {
    it('returns the full owner profile: tenant, technicians, technicianCount, customers, jobs, jobCounts', async () => {
      const { listBuilders } = mockAdmin({
        technicians: { data: technicianListRows, error: null },
        jobsList: {
          data: [jobRow('j1', 'scheduled', '2026-06-21T00:00:00Z')],
          error: null,
        },
        jobCounts: {
          today: 2,
          upcoming: 3,
          overdue: 1,
          completed: 5,
          cancelled: 0,
        },
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
        upiVpa: null,
      });
      if (result.role !== Role.OWNER) throw new Error('expected owner shape');
      expect(result.technicianCount).toBe(1);
      expect(result.technicians[0].skills.sort()).toEqual(
        ['Plumbing', 'Electrical', 'Wiring'].sort(),
      );
      expect(result.customers).toBe(emptyCustomersPage);
      // Story 3.9 — every profile job row now embeds technician + customer.
      // Mocks return no embed rows, so the fallbacks (id-only, null names) show.
      expect(result.jobs.data).toEqual([
        {
          id: 'j1',
          status: 'scheduled',
          technician: {
            id: 'tech-uuid',
            name: null,
            countryCode: '',
            phoneNumber: '',
            skills: [],
          },
          customer: {
            id: 'cust-1',
            name: null,
            countryCode: '',
            phoneNumber: '',
            address: null,
            city: null,
          },
        },
      ]);
      // Story 3.7 — the profile's explicit select list must name completed_at;
      // omitting it silently drops the key through the `as JobRow[]` cast.
      expect(
        (listBuilders[0] as unknown as { selectCols: string }).selectCols,
      ).toContain('completed_at');
      expect(result.jobCounts).toEqual({
        today: 2,
        upcoming: 3,
        overdue: 1,
        completed: 5,
        cancelled: 0,
      });
    });

    it('issues the five count queries with the Story 3.7 bucket predicates', async () => {
      const { countBuilders } = mockAdmin({
        jobCounts: {
          today: 1,
          upcoming: 2,
          overdue: 3,
          completed: 4,
          cancelled: 5,
        },
      });
      const range = getIstDayRange();

      const result = await service.getMyProfile(ownerUser, {});

      if (result.role !== Role.OWNER) throw new Error('expected owner shape');
      // Call order is fixed: today, upcoming, overdue, completed, cancelled.
      expect(result.jobCounts).toEqual({
        today: 1,
        upcoming: 2,
        overdue: 3,
        completed: 4,
        cancelled: 5,
      });
      expect(countBuilders).toHaveLength(5);

      const [today, upcoming, overdue, completed, cancelled] = countBuilders;
      // today: scheduled_start within [start, end), action statuses only
      expect(today.gte).toHaveBeenCalledWith(
        'scheduled_start',
        range.start.toISOString(),
      );
      expect(today.lt).toHaveBeenCalledWith(
        'scheduled_start',
        range.end.toISOString(),
      );
      expect(today.in).toHaveBeenCalledWith('status', [
        JobStatus.SCHEDULED,
        JobStatus.IN_PROGRESS,
      ]);
      // upcoming: starts at start of tomorrow IST (= today's range.end), scheduled only
      expect(upcoming.gte).toHaveBeenCalledWith(
        'scheduled_start',
        range.end.toISOString(),
      );
      expect(upcoming.lt).not.toHaveBeenCalled();
      expect(upcoming.eq).toHaveBeenCalledWith('status', JobStatus.SCHEDULED);
      // overdue: before today's window, action statuses only
      expect(overdue.lt).toHaveBeenCalledWith(
        'scheduled_start',
        range.start.toISOString(),
      );
      expect(overdue.gte).not.toHaveBeenCalled();
      expect(overdue.in).toHaveBeenCalledWith('status', [
        JobStatus.SCHEDULED,
        JobStatus.IN_PROGRESS,
      ]);
      // completed / cancelled: all-time totals, no day window
      expect(completed.eq).toHaveBeenCalledWith('status', JobStatus.COMPLETED);
      expect(cancelled.eq).toHaveBeenCalledWith('status', JobStatus.CANCELLED);
      // every bucket is tenant-wide and head:true count:'exact'
      for (const b of countBuilders) {
        expect(b.eq).toHaveBeenCalledWith('tenant_id', 'tenant-uuid');
        expect(b.technicianIdArg).toBeUndefined();
      }
    });

    it('includes not-yet-accepted (status: invited) technicians alongside active ones', async () => {
      const mixedStatusRows = [
        { ...technicianListRows[0], id: 'tech-active', status: 'active' },
        {
          id: 'tech-invited',
          name: 'Newly Invited',
          country_code: '+91',
          phone_number: '9222222222',
          status: 'invited',
          created_at: '2026-07-01T00:00:00Z',
          user_skills: [
            { skills: { id: 'skill-1', name: 'AC Repair' } },
          ],
        },
      ];
      mockAdmin({ technicians: { data: mixedStatusRows, error: null } });
      customersService.listCustomers.mockResolvedValue(emptyCustomersPage);

      const result = await service.getMyProfile(ownerUser, {});

      if (result.role !== Role.OWNER) throw new Error('expected owner shape');
      expect(result.technicianCount).toBe(2);
      expect(result.technicians.map((t) => t.status)).toEqual([
        'active',
        'invited',
      ]);
      expect(result.technicians[1].id).toBe('tech-invited');
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
        'profile-jobs',
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
      expect(result.jobCounts).toEqual({
        today: 0,
        upcoming: 0,
        overdue: 0,
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

    it('throws 500 when a job counts query errors', async () => {
      mockAdmin({ jobCounts: { error: { code: '08006' } } });

      await expect(service.getMyProfile(ownerUser, {})).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('getMyProfile — technician', () => {
    it('returns the technician profile: own skills, own jobs, own jobCounts', async () => {
      mockAdmin({
        ownRow: { data: ownTechnicianRow, error: null },
        ownSkills: { data: ownSkillsRows, error: null },
        jobsList: {
          data: [jobRow('j2', 'in_progress', '2026-06-21T00:00:00Z')],
          error: null,
        },
        jobCounts: {
          today: 1,
          upcoming: 2,
          overdue: 0,
          completed: 0,
          cancelled: 0,
        },
      });

      const result = await service.getMyProfile(technicianUser, {});

      expect(result.role).toBe(Role.TECHNICIAN);
      if (result.role !== Role.TECHNICIAN)
        throw new Error('expected technician shape');
      expect(result.skills.sort()).toEqual(
        ['AC Repair', 'Pest Control'].sort(),
      );
      expect(result.jobs.data).toEqual([
        {
          id: 'j2',
          status: 'in_progress',
          technician: {
            id: 'tech-uuid',
            name: null,
            countryCode: '',
            phoneNumber: '',
            skills: [],
          },
          customer: {
            id: 'cust-1',
            name: null,
            countryCode: '',
            phoneNumber: '',
            address: null,
            city: null,
          },
        },
      ]);
      expect(result.jobCounts).toEqual({
        today: 1,
        upcoming: 2,
        overdue: 0,
        completed: 0,
        cancelled: 0,
      });
    });

    it('scopes both the jobs list and job counts to the caller only', async () => {
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

  describe('getMyProfile — jobs embed + today scope (Story 3.9)', () => {
    const range = getIstDayRange();

    it('embeds technician and customer summaries on every owner job row, resolved with batched queries', async () => {
      const { usersHandler, skillsHandler, customersHandler } = mockAdmin({
        jobsList: {
          data: [
            jobRow('j1', 'scheduled', '2026-06-21T04:00:00Z'),
            jobRow('j2', 'in_progress', '2026-06-21T07:00:00Z'),
          ],
          error: null,
        },
        batchUsers: {
          data: [
            {
              id: 'tech-uuid',
              name: 'Ravi',
              country_code: '+91',
              phone_number: '9111111111',
            },
          ],
          error: null,
        },
        batchSkills: {
          data: [
            { user_id: 'tech-uuid', skills: { name: 'Plumbing' } },
            { user_id: 'tech-uuid', skills: [{ name: 'Electrical' }] },
          ],
          error: null,
        },
        batchCustomers: {
          data: [
            {
              id: 'cust-1',
              name: 'Sharma Residency',
              country_code: '+91',
              phone_number: '9333333333',
              address: '12 MG Road',
              city: 'Pune',
            },
          ],
          error: null,
        },
      });

      const result = await service.getMyProfile(ownerUser, {});

      if (result.role !== Role.OWNER) throw new Error('expected owner shape');
      expect(result.jobs.data).toHaveLength(2);
      for (const row of result.jobs.data) {
        expect(row.technician).toEqual({
          id: 'tech-uuid',
          name: 'Ravi',
          countryCode: '+91',
          phoneNumber: '9111111111',
          skills: ['Plumbing', 'Electrical'],
        });
        expect(row.customer).toEqual({
          id: 'cust-1',
          name: 'Sharma Residency',
          countryCode: '+91',
          phoneNumber: '9333333333',
          address: '12 MG Road',
          city: 'Pune',
        });
      }

      // Batched: the page's distinct ids resolved with ONE in-filtered query
      // per table (+ one for skills), never one query per row.
      const selectCols = (m: jest.Mock): string[] =>
        m.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(selectCols(usersHandler.select)).toContain(
        'id, name, country_code, phone_number',
      );
      expect(selectCols(skillsHandler.select)).toContain(
        'user_id, skills!inner(name)',
      );
      expect(selectCols(customersHandler.select)).toContain(
        'id, name, country_code, phone_number, address, city',
      );
      // Every plain-columns select returns its own in() builder; collect the
      // ones that were actually driven by the batched embed fetch.
      const inCalls = (handlerSelect: jest.Mock): unknown[][] =>
        handlerSelect.mock.results
          .map((r): jest.Mock | undefined => (r.value as { in?: jest.Mock }).in)
          .filter((m): m is jest.Mock => Boolean(m))
          .flatMap((m): unknown[] => m.mock.calls);
      expect(inCalls(usersHandler.select)).toContainEqual([
        'id',
        ['tech-uuid'],
      ]);
      expect(inCalls(skillsHandler.select)).toContainEqual([
        'user_id',
        ['tech-uuid'],
      ]);
      expect(customersHandler.inIds).toHaveBeenCalledWith('id', ['cust-1']);
      // Tenant filter on every batched fetch — createAdmin() bypasses RLS, so
      // this app-layer eq is the only cross-tenant guard on these reads.
      // (The skills fetch carries none: global skills are tenant-free since
      // Story 4.2, and the techIds are already tenant-verified via users.)
      expect(usersHandler.batchUsersEq).toHaveBeenCalledWith(
        'tenant_id',
        'tenant-uuid',
      );
      expect(customersHandler.eqTenant).toHaveBeenCalledWith(
        'tenant_id',
        'tenant-uuid',
      );
    });

    it('embeds the technician summary on technician-branch job rows too', async () => {
      mockAdmin({
        ownRow: { data: ownTechnicianRow, error: null },
        jobsList: {
          data: [jobRow('j2', 'scheduled', '2026-06-21T04:00:00Z')],
          error: null,
        },
        batchUsers: {
          data: [
            {
              id: 'tech-uuid',
              name: 'Ravi',
              country_code: '+91',
              phone_number: '9111111111',
            },
          ],
          error: null,
        },
      });

      const result = await service.getMyProfile(technicianUser, {});

      if (result.role !== Role.TECHNICIAN)
        throw new Error('expected technician shape');
      expect(result.jobs.data[0].technician).toEqual({
        id: 'tech-uuid',
        name: 'Ravi',
        countryCode: '+91',
        phoneNumber: '9111111111',
        skills: [],
      });
      expect(result.jobs.data[0].customer.id).toBe('cust-1');
    });

    it('keeps the technician embed present (id-only fallback) when the users row is missing', async () => {
      // technician_id is NOT NULL, so a missing users row is a data anomaly —
      // the key must still be present so clients never see an unassigned job.
      mockAdmin({
        jobsList: {
          data: [jobRow('j1', 'scheduled', '2026-06-21T04:00:00Z')],
          error: null,
        },
      });

      const result = await service.getMyProfile(ownerUser, {});

      if (result.role !== Role.OWNER) throw new Error('expected owner shape');
      expect(result.jobs.data[0].technician).toEqual({
        id: 'tech-uuid',
        name: null,
        countryCode: '',
        phoneNumber: '',
        skills: [],
      });
    });

    it('keeps the customer embed present (id-only fallback) when the customers row is missing', async () => {
      // customer_id is NOT NULL too, so a missing customers row is equally a
      // data anomaly (e.g. mid-page deletion) — same id-only fallback rule.
      mockAdmin({
        jobsList: {
          data: [jobRow('j1', 'scheduled', '2026-06-21T04:00:00Z')],
          error: null,
        },
      });

      const result = await service.getMyProfile(ownerUser, {});

      if (result.role !== Role.OWNER) throw new Error('expected owner shape');
      expect(result.jobs.data[0].customer).toEqual({
        id: 'cust-1',
        name: null,
        countryCode: '',
        phoneNumber: '',
        address: null,
        city: null,
      });
    });

    it('throws 500 when a batched embed query errors', async () => {
      mockAdmin({
        jobsList: {
          data: [jobRow('j1', 'scheduled', '2026-06-21T04:00:00Z')],
          error: null,
        },
        batchCustomers: { data: null, error: { code: '08006' } },
      });

      await expect(service.getMyProfile(ownerUser, {})).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('skips the batched embed queries entirely for an empty jobs page', async () => {
      const { usersHandler, skillsHandler, customersHandler } = mockAdmin({});

      const result = await service.getMyProfile(ownerUser, {});

      if (result.role !== Role.OWNER) throw new Error('expected owner shape');
      expect(result.jobs.data).toHaveLength(0);
      // The customers table is only ever touched by the embed assembly, so
      // zero select calls proves the empty-page guard fired.
      expect(customersHandler.select).not.toHaveBeenCalled();
      // And the users/skills batched branches never ran either (their select
      // column lists are distinct from the own-profile/technician-list ones).
      expect(usersHandler.select).not.toHaveBeenCalledWith(
        'id, name, country_code, phone_number',
      );
      expect(skillsHandler.select).not.toHaveBeenCalledWith(
        'user_id, skills!inner(name)',
      );
    });

    it('combines jobsScope=today with the technician branch (day window ORed with in_progress + own-jobs filter + embeds)', async () => {
      const { listBuilders } = mockAdmin({
        ownRow: { data: ownTechnicianRow, error: null },
        jobsList: {
          data: [jobRow('j1', 'scheduled', '2026-06-21T04:00:00Z')],
          error: null,
        },
        batchUsers: {
          data: [
            {
              id: 'tech-uuid',
              name: 'Ravi',
              country_code: '+91',
              phone_number: '9111111111',
            },
          ],
          error: null,
        },
      });

      const result = await service.getMyProfile(technicianUser, {
        jobsScope: 'today',
      });

      const list = listBuilders[0];
      expect(list.eq).toHaveBeenCalledWith('technician_id', 'tech-uuid');
      // Same OR branch as GET /jobs?scope=today — an active job must not
      // vanish from the profile's Today page when its slot crosses midnight.
      expect(list.or).toHaveBeenCalledWith(
        expect.stringMatching(
          /^and\(scheduled_start\.gte\..+,scheduled_start\.lt\..+\),status\.eq\.in_progress$/,
        ),
      );
      expect(list.order).toHaveBeenCalledWith('scheduled_start', {
        ascending: true,
      });
      if (result.role !== Role.TECHNICIAN)
        throw new Error('expected technician shape');
      expect(result.jobs.data[0].technician.name).toBe('Ravi');
      expect(result.jobs.data[0].customer.id).toBe('cust-1');
    });

    it('treats explicit jobsScope=all exactly like the omitted default (no day window, created_at DESC)', async () => {
      const { listBuilders } = mockAdmin({});

      await service.getMyProfile(ownerUser, { jobsScope: 'all' });

      const list = listBuilders[0];
      expect(list.gte).not.toHaveBeenCalled();
      expect(list.lt).not.toHaveBeenCalled();
      expect(list.order).toHaveBeenCalledWith('created_at', {
        ascending: false,
      });
      expect(list.order).toHaveBeenCalledWith('id', { ascending: false });
      expect(list.eq).not.toHaveBeenCalledWith('status', expect.anything());
    });

    it('returns hasMore=false with a null nextCursor when the today page is short', async () => {
      mockAdmin({
        jobsList: {
          data: [jobRow('j1', 'scheduled', '2026-06-21T04:00:00Z')],
          error: null,
        },
      });

      const result = await service.getMyProfile(ownerUser, {
        jobsScope: 'today',
      });

      if (result.role !== Role.OWNER) throw new Error('expected owner shape');
      expect(result.jobs.hasMore).toBe(false);
      expect(result.jobs.nextCursor).toBeNull();
    });

    it("jobsScope='today' adds the IST day window on scheduled_start and sorts ASC, with no status filter", async () => {
      const { listBuilders } = mockAdmin({});

      await service.getMyProfile(ownerUser, { jobsScope: 'today' });

      const list = listBuilders[0];
      // Owners keep the pure day-window view — no in_progress OR branch.
      expect(list.or).not.toHaveBeenCalled();
      expect(list.gte).toHaveBeenCalledWith(
        'scheduled_start',
        range.start.toISOString(),
      );
      expect(list.lt).toHaveBeenCalledWith(
        'scheduled_start',
        range.end.toISOString(),
      );
      // No status filter — parity with GET /jobs?scope=today: the FE drops
      // completed/cancelled rows from display, the payload stays honest.
      expect(list.order).toHaveBeenCalledWith('scheduled_start', {
        ascending: true,
      });
      expect(list.order).toHaveBeenCalledWith('id', { ascending: true });
      expect(list.eq).not.toHaveBeenCalledWith('status', expect.anything());
    });

    it('default scope (all) keeps created_at DESC with no day window', async () => {
      const { listBuilders } = mockAdmin({});

      await service.getMyProfile(ownerUser, {});

      const list = listBuilders[0];
      expect(list.gte).not.toHaveBeenCalled();
      expect(list.lt).not.toHaveBeenCalled();
      expect(list.order).toHaveBeenCalledWith('created_at', {
        ascending: false,
      });
      expect(list.order).toHaveBeenCalledWith('id', { ascending: false });
    });

    it("jobsScope='today' paginates with a scheduled_start-ASC keyset cursor", async () => {
      const { listBuilders } = mockAdmin({});
      const cursor = encodeCursor(
        '11111111-1111-4111-8111-111111111111',
        '2026-06-21T04:00:00.000Z',
        'profile-jobs-today',
      );

      await service.getMyProfile(ownerUser, {
        jobsScope: 'today',
        jobsCursor: cursor,
      });

      expect(listBuilders[0].or).toHaveBeenCalledWith(
        'scheduled_start.gt.2026-06-21T04:00:00.000Z,' +
          'and(scheduled_start.eq.2026-06-21T04:00:00.000Z,' +
          'id.gt.11111111-1111-4111-8111-111111111111)',
      );
    });

    it('rejects a profile-jobs cursor on the today scope (and vice versa) with 400', async () => {
      const wrongScope = encodeCursor(
        '11111111-1111-4111-8111-111111111111',
        '2026-06-21T00:00:00.000Z',
        'profile-jobs',
      );
      mockAdmin({});

      await expect(
        service.getMyProfile(ownerUser, {
          jobsScope: 'today',
          jobsCursor: wrongScope,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a profile-jobs-today cursor on the default scope with 400', async () => {
      const todayCursor = encodeCursor(
        '11111111-1111-4111-8111-111111111111',
        '2026-06-21T04:00:00.000Z',
        'profile-jobs-today',
      );
      mockAdmin({});

      await expect(
        service.getMyProfile(ownerUser, { jobsCursor: todayCursor }),
      ).rejects.toThrow(BadRequestException);
    });

    it('mints next cursors with the scope-matching tag', async () => {
      // Two pages' worth of rows: hasMore true, so a nextCursor is minted.
      // UUID ids — decodeCursor validates the payload's id format.
      const rows = [
        jobRow(
          'a1111111-1111-4111-8111-111111111111',
          'scheduled',
          '2026-06-21T04:00:00Z',
        ),
        jobRow(
          'a2222222-2222-4222-8222-222222222222',
          'scheduled',
          '2026-06-21T05:00:00Z',
        ),
      ];
      mockAdmin({
        jobsList: { data: rows, error: null },
        jobCounts: {
          today: 0,
          upcoming: 0,
          overdue: 0,
          completed: 0,
          cancelled: 0,
        },
      });

      const result = await service.getMyProfile(ownerUser, {
        jobsScope: 'today',
        jobsLimit: 1,
      });

      if (result.role !== Role.OWNER) throw new Error('expected owner shape');
      expect(result.jobs.hasMore).toBe(true);
      const decoded = decodeCursor(result.jobs.nextCursor as string);
      expect(decoded.scope).toBe('profile-jobs-today');
      expect(decoded.id).toBe('a1111111-1111-4111-8111-111111111111');
      expect(decoded.createdAt).toBe('2026-06-21T04:00:00Z');
    });
  });
});
