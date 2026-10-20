import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import {
  UsersService,
  type CompanyProfileResponse,
  type UserProfileResponse,
} from './users.service';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { CustomersService } from '../customers/customers.service';
import { JobsService } from '../jobs/jobs.service';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import {
  memberRow,
  membersTable,
  type FilterCall,
  type StubMemberRow,
} from '../../test/helpers/member-rows-stub';
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

// The company-wide shape (company admin, viewer, platform admin, or a person
// with no company) carries the roster; only the employee shape does not.
function expectCompany(
  r: UserProfileResponse,
): asserts r is CompanyProfileResponse {
  if (r.role === Role.EMPLOYEE) throw new Error('expected company shape');
}

describe('UsersService', () => {
  let service: UsersService;
  let supabaseClientFactory: jest.Mocked<SupabaseClientFactory>;
  let customersService: { listCustomers: jest.Mock; countCustomers: jest.Mock };
  let jobsService: { toResponse: jest.Mock };

  const ownerUser: RequestUser = {
    userId: 'owner-uuid',
    tenantId: 'tenant-uuid',
    role: Role.COMPANY_ADMIN,
    platformAdmin: false,
    rawJwt: 'jwt',
  };

  const technicianUser: RequestUser = {
    userId: 'tech-uuid',
    tenantId: 'tenant-uuid',
    role: Role.EMPLOYEE,
    platformAdmin: false,
    rawJwt: 'jwt',
  };

  // Role and company come from the request user (read from the database by
  // the auth guard); the users row is identity only.
  const ownOwnerRow = {
    id: 'owner-uuid',
    name: 'Ashish',
    country_code: '+91',
    phone_number: '9000000000',
  };

  const ownTechnicianRow = {
    id: 'tech-uuid',
    name: 'Ravi',
    country_code: '+91',
    phone_number: '9111111111',
  };

  // The employee code and status live on the person's membership.
  const ownerMembership = { employee_code: 'EMP-001', status: 'active' };
  const technicianMembership = { employee_code: 'EMP-004', status: 'active' };

  const tenantRow = {
    id: 'tenant-uuid',
    company_name: 'Acme Services',
    gstin: null,
    address: '12 MG Road',
    state_code: 'MH',
    upi_vpa: null,
  };

  const technicianListRows: StubMemberRow[] = [
    (() => {
      const row = memberRow('tech-uuid', {
        name: 'Ravi',
        employeeCode: 'EMP-004',
        phoneNumber: '9111111111',
        createdAt: '2026-06-01T00:00:00Z',
      });
      // one skill uses the object embed shape, another the array embed shape —
      // exercises both normalization branches in the member reader.
      row.users!.user_skills = [
        { skills: { id: 'skill-1', name: 'Plumbing' } },
        {
          skills: [
            { id: 'skill-2', name: 'Electrical' },
            { id: 'skill-3', name: 'Wiring' },
          ],
        },
      ];
      return row;
    })(),
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
      scheduled_start: createdAt,
      scheduled_end: null,
      status,
      completed_at: null,
      current_step: null,
      priority: 'normal',
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
      countCustomers: jest.fn().mockResolvedValue(0),
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

  // users.select(...).eq('id',...).single() — the caller's own identity row.
  function usersTableHandler(ownResult: DbResult) {
    const single = jest.fn().mockResolvedValue(ownResult);
    const eqId = jest.fn().mockReturnValue({ single });
    return { select: jest.fn().mockReturnValue({ eq: eqId }), eqId };
  }

  // memberships: three different reads, told apart by the select() columns.
  //  - 'employee_code, status' ...eq(user_id).eq(tenant_id).maybeSingle():
  //    the caller's own membership.
  //  - columns naming user_skills: the company-member reader for the roster.
  //  - any other member-reader select: the batched job-embed names read.
  // Every member-reader filter is recorded so tests can pin the company
  // filter, the role filter and the removed-member rule.
  function membershipsTableHandler(
    ownMembership: DbResult,
    rosterResult: DbResult,
    batchResult: DbResult,
  ) {
    const maybeSingle = jest.fn().mockResolvedValue(ownMembership);
    const ownEqs: unknown[][] = [];
    const ownNode: Record<string, unknown> = { maybeSingle };
    ownNode['eq'] = jest.fn((...args: unknown[]) => {
      ownEqs.push(args);
      return ownNode;
    });
    const reads: Array<{ cols: string; filters: FilterCall[] }> = [];
    const roster = membersTable(rosterResult as never);
    const batch = membersTable(batchResult as never);
    const select = jest.fn((cols: string) => {
      if (cols.startsWith('employee_code')) return ownNode;
      const table = cols.includes('user_skills') ? roster : batch;
      reads.push({ cols, filters: table.filters });
      return table.select(cols);
    });
    return { select, ownEqs, reads };
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
    /** Roster rows as the member reader returns them (memberRow(...)). */
    technicians?: DbResult;
    ownMembership?: DbResult;
    ownSkills?: DbResult;
    jobsList?: DbResult;
    jobCounts?: Record<string, number> | { error: unknown };
    /** Member rows for the batched job-embed names (memberRow(...)). */
    batchUsers?: DbResult;
    batchSkills?: DbResult;
    batchCustomers?: DbResult;
    /** 15-7 access view; null data maps to the profile's NO_ATTENDANCE default. */
    accessState?: DbResult;
  }) {
    const ownRow = opts.ownRow ?? { data: ownOwnerRow, error: null };
    const ownMembership = opts.ownMembership ?? {
      data: ownerMembership,
      error: null,
    };
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

    const usersHandler = usersTableHandler(ownRow);
    const membershipsHandler = membershipsTableHandler(
      ownMembership,
      technicians,
      batchUsers,
    );
    const skillsHandler = userSkillsTableHandler(ownSkills, batchSkills);
    const customersHandler = customersTableHandler(batchCustomers);

    const from = jest.fn((table: string) => {
      if (table === 'users') return usersHandler;
      if (table === 'memberships') return membershipsHandler;
      if (table === 'tenants') return tenantsTableHandler(tenant);
      if (table === 'user_skills') return skillsHandler;
      if (table === 'customers') return customersHandler;
      if (table === 'attendance_access_state') {
        // 15-7: select(*).eq(user_id).eq(tenant_id).maybeSingle() — the
        // awaited chain resolves to the queued result.
        const builder: Record<string, jest.Mock> = {};
        for (const m of ['select', 'eq', 'maybeSingle']) {
          builder[m] = jest.fn().mockImplementation(() =>
            m === 'maybeSingle'
              ? Promise.resolve(
                  opts.accessState ?? { data: null, error: null },
                )
              : builder,
          );
        }
        return builder;
      }
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
      membershipsHandler,
      skillsHandler,
      customersHandler,
    };
  }

  describe('getMyProfile — owner', () => {
    it('returns the full owner profile: tenant, technicians, technicianCount, customers, jobs, jobCounts', async () => {
      const { listBuilders, membershipsHandler } = mockAdmin({
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
      customersService.countCustomers.mockResolvedValue(24);

      const result = await service.getMyProfile(ownerUser, {});

      expect(result.role).toBe(Role.COMPANY_ADMIN);
      expect(result.id).toBe('owner-uuid');
      expect(result.name).toBe('Ashish');
      // Human-readable per-tenant reference (SPEC-human-readable-ids).
      expect(result.employeeCode).toBe('EMP-001');
      expectCompany(result);
      expect(result.technicians[0].employeeCode).toBe('EMP-004');
      // Both membership selects (own row + roster) actually REQUEST the
      // column — reverting the select widening would otherwise stay suite-green.
      const memberSelects = membershipsHandler.select.mock.calls.map(
        (c: unknown[]) => c[0] as string,
      );
      expect(memberSelects.find((s) => s.startsWith('employee_code'))).toContain(
        'status',
      );
      expect(memberSelects.find((s) => s.includes('user_skills'))).toContain(
        'employee_code',
      );
      // Own membership is read for THIS person in THIS company only.
      expect(membershipsHandler.ownEqs).toEqual([
        ['user_id', 'owner-uuid'],
        ['tenant_id', 'tenant-uuid'],
      ]);
      // The roster is the company's employees, removed members left out.
      const roster = membershipsHandler.reads.find((r) =>
        r.cols.includes('user_skills'),
      )!;
      expect(roster.filters).toEqual(
        expect.arrayContaining([
          ['eq', 'tenant_id', 'tenant-uuid'],
          ['eq', 'role', 'employee'],
          ['neq', 'status', 'removed'],
        ]),
      );
      expect(result.platformAdmin).toBe(false);
      expect(result.tenant).toEqual({
        id: 'tenant-uuid',
        companyName: 'Acme Services',
        gstin: null,
        address: '12 MG Road',
        stateCode: 'MH',
        upiVpa: null,
      });
      expectCompany(result);
      expect(result.technicianCount).toBe(1);
      // The customer total comes from customersService.countCustomers — the
      // embedded `customers` block is only one cursor-paginated page.
      expect(result.customerCount).toBe(24);
      expect(customersService.countCustomers).toHaveBeenCalledWith(
        'tenant-uuid',
      );
      expect(result.technicians[0].skills.sort()).toEqual(
        ['Plumbing', 'Electrical', 'Wiring'].sort(),
      );
      expect(result.technicians[0].skillIds.sort()).toEqual(
        ['skill-1', 'skill-2', 'skill-3'],
      );
      expect(result.customers).toBe(emptyCustomersPage);
      // 2026-09-30 — the owner branch carries the attendance mirror too (the
      // tenant flag gates the Home entry point). The mock's view read
      // resolves no row → the attendance-free default.
      expect(result.attendance).toEqual({
        attendanceEnabled: false,
        attendanceAccess: 'none',
        attendanceStartDate: null,
        onboardedAt: null,
        pendingLeaveRequests: 0,
      });
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

    it('carries the view-driven tenant attendance flag on the owner mirror', async () => {
      // The view computes attendance_enabled for owner rows too — the
      // production truth the Home entry tile gates on. access_state stays
      // whatever the view says ('none' — owners are never enrolled): the
      // branch is a pass-through, never a hardcode.
      mockAdmin({
        accessState: {
          data: {
            attendance_enabled: true,
            access_state: 'none',
            attendance_start_date: null,
            onboarded_at: null,
          },
          error: null,
        },
      });

      const result = await service.getMyProfile(ownerUser, {});

      expectCompany(result);
      expect(result.attendance).toEqual({
        attendanceEnabled: true,
        attendanceAccess: 'none',
        attendanceStartDate: null,
        onboardedAt: null,
        pendingLeaveRequests: 0,
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

      expectCompany(result);
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
        memberRow('tech-active', { name: 'Ravi', status: 'active' }),
        memberRow('tech-invited', {
          name: 'Newly Invited',
          status: 'invited',
          phoneNumber: '9222222222',
          createdAt: '2026-07-01T00:00:00Z',
          skills: [{ id: 'skill-1', name: 'AC Repair' }],
        }),
      ];
      mockAdmin({ technicians: { data: mixedStatusRows, error: null } });
      customersService.listCustomers.mockResolvedValue(emptyCustomersPage);

      const result = await service.getMyProfile(ownerUser, {});

      expectCompany(result);
      expect(result.technicianCount).toBe(2);
      expect(result.technicians.map((t) => t.status)).toEqual([
        'active',
        'invited',
      ]);
      expect(result.technicians[1].id).toBe('tech-invited');
    });

    it("passes the request user's tenantId into customersService.listCustomers", async () => {
      // The company comes from the request user (the guard reads it from the
      // database, or from X-Company-Id for a platform admin) — never a claim.
      mockAdmin({});

      await service.getMyProfile(ownerUser, {});

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

    it('returns a minimal profile pre-onboarding (no company) without touching tenant/technicians/jobs/customers', async () => {
      const { from } = mockAdmin({});
      // A person with no company: role and tenant are null on the request user.
      const noCompany: RequestUser = {
        ...ownerUser,
        tenantId: null,
        role: null,
      };

      const result = await service.getMyProfile(noCompany, {});

      expect(result.role).toBeNull();
      expect(result.employeeCode).toBeNull();
      expect(result.tenant).toBeNull();
      expectCompany(result);
      expect(result.technicians).toEqual([]);
      expect(result.technicianCount).toBe(0);
      expect(result.customerCount).toBe(0);
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
      // No tenant → no view row → the attendance-free default (the shape
      // stays present so the FE gate reads one stable field).
      expect(result.attendance).toEqual({
        attendanceEnabled: false,
        attendanceAccess: 'none',
        attendanceStartDate: null,
        onboardedAt: null,
        pendingLeaveRequests: 0,
      });
      // only the own-profile lookup should have run (no membership to read)
      expect(from).toHaveBeenCalledTimes(1);
      expect(from).toHaveBeenCalledWith('users');
      expect(customersService.listCustomers).not.toHaveBeenCalled();
      expect(customersService.countCustomers).not.toHaveBeenCalled();
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

    // Sixth parallel fetch — the customer total. Pinned at the profile level
    // (not just inside CustomersService) so a future `.catch(() => 0)` cannot
    // silently downgrade this failure while every sibling still 500s.
    it('throws 500 when the customer-count query errors', async () => {
      mockAdmin({});
      customersService.countCustomers.mockRejectedValueOnce(
        new InternalServerErrorException({
          error_code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to count customers',
        }),
      );

      await expect(service.getMyProfile(ownerUser, {})).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('getMyProfile — technician', () => {
    it('returns the technician profile: own skills, own jobs, own jobCounts', async () => {
      mockAdmin({
        ownRow: { data: ownTechnicianRow, error: null },
        ownMembership: { data: technicianMembership, error: null },
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
        // 15-7: the access view rides the same profile response.
        accessState: {
          data: {
            attendance_enabled: true,
            access_state: 'active',
            attendance_start_date: '2026-09-01',
            onboarded_at: '2026-09-01T05:30:00+00:00',
          },
          error: null,
        },
      });

      const result = await service.getMyProfile(technicianUser, {});

      expect(result.role).toBe(Role.EMPLOYEE);
      if (result.role !== Role.EMPLOYEE)
        throw new Error('expected technician shape');
      // AD-17: first load carries the same access facts me/access serves.
      expect(result.attendance).toEqual({
        attendanceEnabled: true,
        attendanceAccess: 'active',
        attendanceStartDate: '2026-09-01',
        onboardedAt: '2026-09-01T05:30:00+00:00',
        pendingLeaveRequests: 0,
      });
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

    it('profile jobs select carries the skill/template embeds (Story 4.5)', async () => {
      const { listBuilders } = mockAdmin({
        ownRow: { data: ownTechnicianRow, error: null },
        ownMembership: { data: technicianMembership, error: null },
      });

      await service.getMyProfile(technicianUser, {});

      const cols = (listBuilders[0] as unknown as { selectCols: string })
        .selectCols;
      expect(cols).toContain('skills(id, name)');
      expect(cols).toContain('workflow_templates(version, steps)');
    });

    it('profile job rows carry the widened Story 4.5 fields through the toResponse passthrough', async () => {
      // toResponse is stubbed minimally elsewhere in this spec (the real
      // mapping is covered in jobs.service.spec); here it returns the widened
      // JobResponse shape so the pin is on THIS endpoint's wiring — the
      // embedProfileJobs spread must not trim skill/workflowTemplate/
      // currentStepIndex off the profile path.
      jobsService.toResponse.mockImplementation(
        (row: { id: string; current_step?: string | null }) => ({
          id: row.id,
          skill: { id: 'skill-uuid-1', name: 'Plumbing' },
          workflowTemplate: { version: 1, steps: [] },
          currentStepIndex: row.current_step ? 0 : null,
        }),
      );
      mockAdmin({
        ownRow: { data: ownTechnicianRow, error: null },
        ownMembership: { data: technicianMembership, error: null },
        jobsList: {
          data: [jobRow('j2', 'in_progress', '2026-06-21T00:00:00Z')],
          error: null,
        },
      });

      const result = await service.getMyProfile(technicianUser, {});

      if (result.role !== Role.EMPLOYEE)
        throw new Error('expected technician shape');
      const job = result.jobs.data[0];
      expect(job.skill).toEqual({ id: 'skill-uuid-1', name: 'Plumbing' });
      expect(job.workflowTemplate).toEqual({ version: 1, steps: [] });
      // current_step is null on the fixture row → null index.
      expect(job.currentStepIndex).toBeNull();
      // The Story 3.9 technician/customer embeds still ride the same row.
      expect(job.technician.id).toBe('tech-uuid');
      expect(job.customer.id).toBe('cust-1');
    });

    it('scopes both the jobs list and job counts to the caller only', async () => {
      const { countBuilders, listBuilders } = mockAdmin({
        ownRow: { data: ownTechnicianRow, error: null },
        ownMembership: { data: technicianMembership, error: null },
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
      mockAdmin({ ownRow: { data: ownTechnicianRow, error: null },
        ownMembership: { data: technicianMembership, error: null } });

      await service.getMyProfile(technicianUser, {});

      expect(customersService.listCustomers).not.toHaveBeenCalled();
    });

    it('returns the minimal company-wide shape (role null) for an employee who lost their company', async () => {
      mockAdmin({ ownRow: { data: ownTechnicianRow, error: null } });
      // A removed employee (or a never-invited person) has no active company.
      const removed: RequestUser = {
        ...technicianUser,
        tenantId: null,
        role: null,
      };

      const result = await service.getMyProfile(removed, {});

      expect(result.tenant).toBeNull();
      // Never the employee shape without an active membership.
      expect(result.role).toBeNull();
      expectCompany(result);
      expect(result.technicians).toEqual([]);
      expect(result.jobs).toEqual({
        data: [],
        nextCursor: null,
        hasMore: false,
      });
    });

    it('throws 500 when the own-skills query errors', async () => {
      mockAdmin({
        ownRow: { data: ownTechnicianRow, error: null },
        ownMembership: { data: technicianMembership, error: null },
        ownSkills: { data: null, error: { code: '08006' } },
      });

      await expect(service.getMyProfile(technicianUser, {})).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('getMyProfile — viewer, platform admin and membership reads', () => {
    const viewerUser: RequestUser = {
      ...ownerUser,
      userId: 'viewer-uuid',
      role: Role.VIEWER,
    };
    const platformAdminUser: RequestUser = {
      ...ownerUser,
      userId: 'staff-uuid',
      role: Role.PLATFORM_ADMIN,
      platformAdmin: true,
    };

    it('serves a viewer the company-wide shape with their own membership code', async () => {
      const { membershipsHandler } = mockAdmin({
        ownRow: {
          data: { ...ownOwnerRow, id: 'viewer-uuid', name: 'Vina' },
          error: null,
        },
        ownMembership: {
          data: { employee_code: 'EMP-009', status: 'active' },
          error: null,
        },
        technicians: { data: technicianListRows, error: null },
      });

      const result = await service.getMyProfile(viewerUser, {});

      expect(result.role).toBe(Role.VIEWER);
      expectCompany(result);
      expect(result.employeeCode).toBe('EMP-009');
      expect(result.tenant?.id).toBe('tenant-uuid');
      expect(result.technicianCount).toBe(1);
      expect(membershipsHandler.ownEqs).toContainEqual([
        'user_id',
        'viewer-uuid',
      ]);
    });

    it('serves a platform admin acting on a company: company data, platformAdmin true, no membership read', async () => {
      const { membershipsHandler } = mockAdmin({
        ownRow: {
          data: { ...ownOwnerRow, id: 'staff-uuid', name: 'Fenzit Staff' },
          error: null,
        },
      });

      const result = await service.getMyProfile(platformAdminUser, {});

      expect(result.role).toBe(Role.PLATFORM_ADMIN);
      expect(result.platformAdmin).toBe(true);
      expect(result.tenant?.id).toBe('tenant-uuid');
      // Fenzit staff have no membership, so no employee code or status of
      // their own — and nothing is read to look for one.
      expect(result.employeeCode).toBeNull();
      expect(membershipsHandler.ownEqs).toEqual([]);
      expect(customersService.listCustomers).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-uuid' }),
        expect.anything(),
      );
    });

    it('serves a platform admin who named no company a minimal profile (role platform_admin, no tenant)', async () => {
      const { from } = mockAdmin({});
      const noCompany: RequestUser = { ...platformAdminUser, tenantId: null };

      const result = await service.getMyProfile(noCompany, {});

      expect(result.role).toBe(Role.PLATFORM_ADMIN);
      expect(result.platformAdmin).toBe(true);
      expect(result.tenant).toBeNull();
      expectCompany(result);
      expect(result.technicians).toEqual([]);
      expect(from).toHaveBeenCalledTimes(1); // own identity row only
      expect(customersService.listCustomers).not.toHaveBeenCalled();
    });

    it('reports the employee code and membership status from the membership, not the users row', async () => {
      mockAdmin({
        ownRow: { data: ownTechnicianRow, error: null },
        ownMembership: {
          data: { employee_code: 'EMP-004', status: 'invited' },
          error: null,
        },
      });

      const result = await service.getMyProfile(technicianUser, {});

      expect(result.employeeCode).toBe('EMP-004');
      expect(result.status).toBe('invited');
      expect(result.platformAdmin).toBe(false);
    });

    it('reports a null code and a null status when no membership row is found (no access, not active)', async () => {
      mockAdmin({
        ownMembership: { data: null, error: null },
      });

      const result = await service.getMyProfile(ownerUser, {});

      expect(result.employeeCode).toBeNull();
      expect(result.status).toBeNull();
    });

    it('throws 500 when the own-membership read errors', async () => {
      mockAdmin({
        ownMembership: { data: null, error: { code: '08006' } },
      });

      await expect(service.getMyProfile(ownerUser, {})).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('throws 500 when the roster read (member reader) errors', async () => {
      mockAdmin({ technicians: { data: null, error: { code: '08006' } } });

      await expect(service.getMyProfile(viewerUser, {})).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('getMyProfile — jobs embed + today scope (Story 3.9)', () => {
    const range = getIstDayRange();

    it('embeds technician and customer summaries on every owner job row, resolved with batched queries', async () => {
      const { membershipsHandler, skillsHandler, customersHandler } = mockAdmin({
        jobsList: {
          data: [
            jobRow('j1', 'scheduled', '2026-06-21T04:00:00Z'),
            jobRow('j2', 'in_progress', '2026-06-21T07:00:00Z'),
          ],
          error: null,
        },
        batchUsers: {
          data: [
            memberRow('tech-uuid', {
              name: 'Ravi',
              countryCode: '+91',
              phoneNumber: '9111111111',
            }),
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

      expectCompany(result);
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
      expect(selectCols(skillsHandler.select)).toContain(
        'user_id, skills!inner(name)',
      );
      expect(selectCols(customersHandler.select)).toContain(
        'id, name, country_code, phone_number, address, city',
      );
      // The names come from the company-member reader: ONE read for the
      // page's distinct technician ids, never one query per row.
      const embedReads = membershipsHandler.reads.filter(
        (r) => !r.cols.includes('user_skills'),
      );
      expect(embedReads).toHaveLength(1);
      expect(embedReads[0].cols).toContain('name, country_code, phone_number');
      // Every plain-columns select returns its own in() builder; collect the
      // ones that were actually driven by the batched embed fetch.
      const inCalls = (handlerSelect: jest.Mock): unknown[][] =>
        handlerSelect.mock.results
          .map((r): jest.Mock | undefined => (r.value as { in?: jest.Mock }).in)
          .filter((m): m is jest.Mock => Boolean(m))
          .flatMap((m) => m.mock.calls as unknown[][]);
      expect(embedReads[0].filters).toContainEqual([
        'in',
        'user_id',
        ['tech-uuid'],
      ]);
      expect(inCalls(skillsHandler.select)).toContainEqual([
        'user_id',
        ['tech-uuid'],
      ]);
      expect(customersHandler.inIds).toHaveBeenCalledWith('id', ['cust-1']);
      // Company filter on every batched fetch — createAdmin() bypasses RLS, so
      // this app-layer eq is the only cross-tenant guard on these reads.
      // (The skills fetch carries none: global skills are tenant-free since
      // Story 4.2, and the techIds come from this company's own job rows.)
      // History view: a removed employee's name still shows on old jobs.
      expect(embedReads[0].filters).toContainEqual([
        'eq',
        'tenant_id',
        'tenant-uuid',
      ]);
      expect(embedReads[0].filters).not.toContainEqual([
        'neq',
        'status',
        'removed',
      ]);
      expect(customersHandler.eqTenant).toHaveBeenCalledWith(
        'tenant_id',
        'tenant-uuid',
      );
    });

    it('embeds the technician summary on technician-branch job rows too', async () => {
      mockAdmin({
        ownRow: { data: ownTechnicianRow, error: null },
        ownMembership: { data: technicianMembership, error: null },
        jobsList: {
          data: [jobRow('j2', 'scheduled', '2026-06-21T04:00:00Z')],
          error: null,
        },
        batchUsers: {
          data: [
            memberRow('tech-uuid', {
              name: 'Ravi',
              countryCode: '+91',
              phoneNumber: '9111111111',
            }),
          ],
          error: null,
        },
      });

      const result = await service.getMyProfile(technicianUser, {});

      if (result.role !== Role.EMPLOYEE)
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

      expectCompany(result);
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

      expectCompany(result);
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
      const { membershipsHandler, skillsHandler, customersHandler } =
        mockAdmin({});

      const result = await service.getMyProfile(ownerUser, {});

      expectCompany(result);
      expect(result.jobs.data).toHaveLength(0);
      // The customers table is only ever touched by the embed assembly, so
      // zero select calls proves the empty-page guard fired.
      expect(customersHandler.select).not.toHaveBeenCalled();
      // And the users/skills batched branches never ran either (their select
      // column lists are distinct from the own-profile/technician-list ones).
      expect(
        membershipsHandler.reads.filter((r) => !r.cols.includes('user_skills')),
      ).toHaveLength(0);
      expect(skillsHandler.select).not.toHaveBeenCalledWith(
        'user_id, skills!inner(name)',
      );
    });

    it('combines jobsScope=today with the technician branch (day window ORed with in_progress + own-jobs filter + embeds)', async () => {
      const { listBuilders } = mockAdmin({
        ownRow: { data: ownTechnicianRow, error: null },
        ownMembership: { data: technicianMembership, error: null },
        jobsList: {
          data: [jobRow('j1', 'scheduled', '2026-06-21T04:00:00Z')],
          error: null,
        },
        batchUsers: {
          data: [
            memberRow('tech-uuid', {
              name: 'Ravi',
              countryCode: '+91',
              phoneNumber: '9111111111',
            }),
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
      if (result.role !== Role.EMPLOYEE)
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

      expectCompany(result);
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

      expectCompany(result);
      expect(result.jobs.hasMore).toBe(true);
      const decoded = decodeCursor(result.jobs.nextCursor as string);
      expect(decoded.scope).toBe('profile-jobs-today');
      expect(decoded.id).toBe('a1111111-1111-4111-8111-111111111111');
      expect(decoded.createdAt).toBe('2026-06-21T04:00:00Z');
    });
  });
});
