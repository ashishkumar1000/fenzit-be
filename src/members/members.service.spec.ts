import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PgPoolFactory } from '../common/pg/pg-pool.factory';
import { StorageService } from '../storage/storage.service';
import { MembersService } from './members.service';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import { UpdateEmploymentDto } from './dto/update-employment.dto';
import { pushCopyForEvent } from '../push/push-copy';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

type DbResult = { data: unknown; error: unknown };

/** A query builder that records every filter and resolves to `result`. */
function queryStub(result: DbResult) {
  const calls: Array<[string, unknown[]]> = [];
  const builder: Record<string, unknown> = {};
  for (const name of [
    'select',
    'eq',
    'neq',
    'in',
    'order',
    'limit',
    'lt',
    'or',
  ]) {
    builder[name] = jest.fn((...args: unknown[]) => {
      calls.push([name, args]);
      return builder;
    });
  }
  builder['then'] = (resolve: (v: unknown) => void) => resolve(result);
  return { builder, calls };
}

function build(
  opts: {
    query?: DbResult;
    rpc?: DbResult;
    tx?: { query: jest.Mock };
    hierarchyUp?: unknown[];
    hierarchyDown?: unknown[];
    subtreeIds?: string[];
    pendingApprovals?: Array<Record<string, unknown>>;
    approvalTrees?: unknown[][];
  } = {},
) {
  const query = queryStub(opts.query ?? { data: [], error: null });
  const rpc = jest
    .fn()
    .mockResolvedValue(opts.rpc ?? { data: null, error: null });
  const admin = { from: jest.fn(() => query.builder), rpc };
  const factory = {
    createAdmin: jest.fn(() => admin),
  } as unknown as jest.Mocked<SupabaseClientFactory>;
  const storage = {
    presignReadUrl: jest.fn((key: string) =>
      Promise.resolve(`https://signed.example/${key}`),
    ),
  };
  // Member reads now merge one hierarchy query. A stub that answers the
  // recursive walk with no rows gives every member the empty hierarchy;
  // anything else throws, so a stray call is not silently ignored.
  const dispatch = (sql: string) => {
    if (sql.includes('d.root_id')) return { rows: opts.hierarchyDown ?? [] };
    if (sql.includes('select u.node_id, u.ancestor_id')) {
      return { rows: opts.hierarchyUp ?? [] };
    }
    if (sql.includes('with recursive live')) return { rows: [] };
    throw new Error(`unclassified query: ${sql}`);
  };
  const tx = opts.tx ?? {
    query: jest.fn((sql: string) => Promise.resolve(dispatch(sql))),
  };
  const pg = {
    withTransaction: (work: (client: unknown) => Promise<unknown>) => work(tx),
  } as unknown as PgPoolFactory;
  const service = new MembersService(
    factory,
    storage as unknown as StorageService,
    pg,
  );
  return { service, rpc, from: admin.from, query, storage, tx };
}

const companyAdmin: RequestUser = {
  userId: 'admin-1',
  tenantId: 'tenant-A',
  role: Role.COMPANY_ADMIN,
  platformAdmin: false,
  rawJwt: 'jwt',
};

const platformAdmin: RequestUser = {
  userId: 'staff-1',
  tenantId: null,
  role: null,
  platformAdmin: true,
  rawJwt: 'jwt',
};

/** Fenzit staff acting on a named company (X-Company-Id). */
const staffOnCompany: RequestUser = {
  ...platformAdmin,
  tenantId: 'tenant-A',
  role: Role.PLATFORM_ADMIN,
};

/**
 * A pg transaction stand-in for the ported membership writes. It dispatches
 * on the SQL shape (never on call order) and records every query, so a test
 * can assert both the refusals and the writes that did or did not happen.
 */
function buildMembershipWrite(
  opts: {
    caller?: {
      platform_admin: boolean;
      disabled: boolean;
      is_company_admin: boolean;
    } | null;
    tenantExists?: boolean;
    member?: Record<string, unknown> | null;
    otherAdmins?: number;
    manager?: Record<string, unknown> | null;
    managerServes?: boolean;
    probe?: {
      cycle: boolean;
      manager_ancestors: number;
      subtree_depth: number;
    };
    reportIds?: string[];
    auditWritten?: number;
    hierarchyUp?: unknown[];
    hierarchyDown?: unknown[];
    liveMemberIds?: string[];
    subtreeIds?: string[];
    pendingApprovals?: Array<Record<string, unknown>>;
    pendingJobs?: Array<Record<string, unknown>>;
    approvalTrees?: unknown[][];
  } = {},
) {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const tx = {
    query: jest.fn((sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes('attendance_lock_tenant')) return { rows: [] };
      if (sql.includes('as is_company_admin')) {
        return {
          rows:
            opts.caller === undefined
              ? [
                  {
                    platform_admin: false,
                    disabled: false,
                    is_company_admin: true,
                  },
                ]
              : opts.caller
                ? [opts.caller]
                : [],
        };
      }
      if (sql.includes('from public.tenants')) {
        return { rowCount: opts.tenantExists === false ? 0 : 1, rows: [] };
      }
      // 24-3: the subtree walk, the pending-approval snapshot read and the
      // approval tree (before / after / activity check, in call order).
      if (sql.includes('with recursive down')) {
        return {
          rows: (opts.subtreeIds ?? []).map((user_id) => ({ user_id })),
        };
      }
      if (sql.includes('select r.id, r.request_id, r.employee_id')) {
        return { rows: opts.pendingApprovals ?? [] };
      }
      if (
        sql.includes('from public.jobs j') &&
        sql.includes("status = 'pending_approval'")
      ) {
        return { rows: opts.pendingJobs ?? [] };
      }
      if (sql.includes('m.role::text')) {
        return { rows: opts.approvalTrees?.shift() ?? [] };
      }
      if (sql.includes('select m.user_id from public.memberships m')) {
        return {
          rows: (opts.liveMemberIds ?? []).map((user_id) => ({ user_id })),
        };
      }
      if (sql.includes('insert into public.notifications')) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('count(*)::int as n')) {
        return { rows: [{ n: opts.otherAdmins ?? 0 }] };
      }
      if (sql.includes('as serves')) {
        return { rows: [{ serves: opts.managerServes ?? true }] };
      }
      if (
        sql.includes('with recursive live') &&
        sql.includes('subtree_depth')
      ) {
        return {
          rows: [
            opts.probe ?? {
              cycle: false,
              manager_ancestors: 0,
              subtree_depth: 0,
            },
          ],
        };
      }
      if (sql.includes('d.root_id')) {
        return { rows: opts.hierarchyDown ?? [] };
      }
      if (sql.includes('select u.node_id, u.ancestor_id')) {
        return { rows: opts.hierarchyUp ?? [] };
      }
      if (sql.includes('with recursive live')) return { rows: [] };
      if (
        sql.includes('update public.memberships') &&
        sql.includes('returning user_id')
      ) {
        const ids = opts.reportIds ?? [];
        return {
          rowCount: ids.length,
          rows: ids.map((id) => ({ user_id: id })),
        };
      }
      if (sql.includes('insert into public.audit_log')) {
        const targets = (params?.[3] as string[]) ?? [];
        return {
          rowCount: opts.auditWritten ?? targets.length,
          rows: [],
        };
      }
      if (
        sql.includes('select id, role, status, manager_id') ||
        sql.includes('select id, role, manager_id') ||
        sql.includes('select m.id, m.role, m.manager_id')
      ) {
        return { rows: opts.member ? [opts.member] : [] };
      }
      if (
        sql.includes('select m.status, u.disabled') ||
        sql.includes('select m.user_id, m.status, u.disabled')
      ) {
        return { rows: opts.manager ? [opts.manager] : [] };
      }
      if (sql.includes('update public.memberships')) {
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`unclassified query: ${sql}`);
    }),
  };
  return { tx, queries };
}

/** The message of the error, without the status: what a client reads. */
const bodyOf = (e: unknown) => (e as { getResponse(): unknown }).getResponse();

/** The canonical fixture's Employee A (spec-payroll), as the API carries it. */
const fullFormV = {
  employeeCode: 'EMP-001',
  joinDate: '2026-09-01',
  exitDate: null,
  pan: 'ABCPE1234F',
  dateOfBirth: '1995-04-12',
  fatherName: 'Ramesh Sharma',
  motherName: 'Sunita Sharma',
  spouseName: 'Meera Sharma',
  pfAccountNumber: 'PY/ABC/12345/000',
  uanNumber: '101234567890',
  designation: 'Field Technician',
  department: 'Field Operations',
  bankAccountNumber: '1234567890',
  ifscCode: 'HDFC0001234',
  bankName: 'HDFC Bank',
};

describe('MembersService', () => {
  describe('list — photo links', () => {
    function memberRowWithPhoto(userId: string, avatarKey: string | null) {
      return {
        user_id: userId,
        role: 'employee',
        status: 'active',
        employee_code: 'EMP-0001',
        created_at: '2026-06-20T00:00:00Z',
        users: {
          name: `Name ${userId}`,
          country_code: '+91',
          phone_number: '9000000000',
          disabled: false,
          avatar_key: avatarKey,
        },
      };
    }

    it('gives a person with a photo a link, and a person without one null', async () => {
      const { service } = build({
        query: {
          data: [
            memberRowWithPhoto('u-1', 'avatars/u-1/a.jpg'),
            memberRowWithPhoto('u-2', null),
          ],
          error: null,
        },
      });

      const members = await service.list(companyAdmin);

      expect(members[0].avatarUrl).toBe(
        'https://signed.example/avatars/u-1/a.jpg',
      );
      expect(members[1].avatarUrl).toBeNull();
    });

    it('never returns the raw storage key as a field', async () => {
      const { service, storage } = build({
        query: {
          data: [memberRowWithPhoto('u-1', 'avatars/u-1/secret-key.jpg')],
          error: null,
        },
      });

      // A presigned link carries its object path by design, so this test
      // uses an opaque link and checks that the key is not a field of its own.
      storage.presignReadUrl.mockResolvedValueOnce(
        'https://signed.example/opaque',
      );

      const members = await service.list(companyAdmin);

      expect(JSON.stringify(members)).not.toContain('secret-key');
      expect(members[0]).not.toHaveProperty('avatarKey');
    });

    it('signs a photo shared by several rows once, not once per row', async () => {
      const { service, storage } = build({
        query: {
          data: [
            memberRowWithPhoto('u-1', 'avatars/u-1/a.jpg'),
            memberRowWithPhoto('u-1-dup', 'avatars/u-1/a.jpg'),
          ],
          error: null,
        },
      });

      await service.list(companyAdmin);

      expect(storage.presignReadUrl).toHaveBeenCalledTimes(1);
    });

    it('still lists everyone when one photo fails to sign: that person gets null, the rest keep theirs', async () => {
      const { service, storage } = build({
        query: {
          data: [
            memberRowWithPhoto('u-1', 'avatars/u-1/broken.jpg'),
            memberRowWithPhoto('u-2', 'avatars/u-2/ok.jpg'),
          ],
          error: null,
        },
      });
      storage.presignReadUrl.mockRejectedValueOnce(new Error('signing failed'));

      const members = await service.list(companyAdmin);

      expect(members).toHaveLength(2);
      expect(members[0].avatarUrl).toBeNull();
      expect(members[1].avatarUrl).toBe(
        'https://signed.example/avatars/u-2/ok.jpg',
      );
    });

    it('merges each member’s chain and headcount into the list payload', async () => {
      const { service } = build({
        query: {
          data: [
            memberRowWithPhoto('u-1', null),
            memberRowWithPhoto('u-2', null),
          ],
          error: null,
        },
        hierarchyUp: [
          { node_id: 'u-1', ancestor_id: 'u-2', depth: 1, name: 'Boss' },
        ],
        hierarchyDown: [
          { root_id: 'u-1', node_id: 'u-9', depth: 1, disabled: false },
          { root_id: 'u-1', node_id: 'u-10', depth: 2, disabled: false },
        ],
      });

      const members = await service.list(companyAdmin);

      expect(members[0]).toMatchObject({
        managerId: 'u-2',
        managerName: 'Boss',
        chain: [{ userId: 'u-2', name: 'Boss' }],
        headcount: 2,
        directReports: 1,
      });
      expect(members[1]).toMatchObject({ managerId: null, headcount: 0 });
    });
  });

  describe('listPaged — the console team table', () => {
    it('merges the hierarchy into the page rows it returns', async () => {
      const row = (userId: string) => ({
        user_id: userId,
        role: 'employee',
        status: 'active',
        employee_code: `EMP-${userId}`,
        created_at: '2026-06-20T00:00:00Z',
        can_create_jobs: false,
        job_approval_required: false,
        users: {
          name: `Name ${userId}`,
          email: null,
          country_code: '+91',
          phone_number: '9000000000',
          disabled: false,
          avatar_key: null,
        },
      });
      const { service } = build({
        query: { data: [row('u-1'), row('u-2')], error: null },
        hierarchyUp: [
          { node_id: 'u-2', ancestor_id: 'u-1', depth: 1, name: 'Owner' },
        ],
        hierarchyDown: [
          { root_id: 'u-1', node_id: 'u-2', depth: 1, disabled: false },
        ],
      });

      const page = await service.listPaged(companyAdmin, {});

      expect(page.data[1]).toMatchObject({
        managerId: 'u-1',
        managerName: 'Owner',
        headcount: 0,
      });
      expect(page.data[0]).toMatchObject({ headcount: 1, directReports: 1 });
    });
  });

  describe('getMember', () => {
    /** A full membership row as the company-member reader selects it. */
    function memberDetailRow(overrides: Record<string, unknown> = {}) {
      return {
        user_id: 'member-1',
        role: 'employee',
        status: 'active',
        employee_code: 'EMP-001',
        created_at: '2026-06-20T00:00:00Z',
        can_create_jobs: false,
        job_approval_required: false,
        users: {
          name: 'Ravi Kumar',
          email: 'ravi@example.com',
          country_code: '+91',
          phone_number: '9000000000',
          disabled: false,
          avatar_key: null,
          user_skills: [{ skills: { id: 's-1', name: 'Plumbing' } }],
        },
        ...overrides,
      };
    }

    it('answers 404 RESOURCE_NOT_FOUND when the person is not a member of this company (cross-tenant, removed, or unknown)', async () => {
      const { service } = build({ query: { data: [], error: null } });

      const err = await service
        .getMember(companyAdmin, 'stranger-1')
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(NotFoundException);
      expect(bodyOf(err)).toMatchObject({
        error_code: 'RESOURCE_NOT_FOUND',
        message: 'The person is not a member of this company',
      });
    });

    it('serves the exact member view — skills and photo link in, and NO statutory field on it (23-1)', async () => {
      const { service } = build({
        query: { data: [memberDetailRow()], error: null },
      });

      const view = await service.getMember(companyAdmin, 'member-1');

      // Exact shape: the list sibling plus skills and the signed photo link.
      expect(Object.keys(view).sort()).toEqual(
        [
          'avatarUrl',
          'canCreateJobs',
          'chain',
          'countryCode',
          'createdAt',
          'directReports',
          'employeeCode',
          'email',
          'headcount',
          'jobApprovalRequired',
          'managerId',
          'managerName',
          'name',
          'phoneNumber',
          'role',
          'skills',
          'status',
          'userId',
        ].sort(),
      );
      // The 23-1 privacy invariant spelled out field by field: PAN, DOB, PF,
      // UAN and the bank details stay behind GET /members/:id/employment only.
      for (const statutory of [
        'pan',
        'date_of_birth',
        'dateOfBirth',
        'pf_account_number',
        'pfAccountNumber',
        'uan_number',
        'uanNumber',
        'bank_account_number',
        'bankAccountNumber',
        'ifsc',
        'ifscCode',
        'bank_name',
        'bankName',
      ]) {
        expect(view).not.toHaveProperty(statutory);
      }
      expect(JSON.stringify(view)).not.toContain('avatarKey');
      expect(view.skills).toEqual([{ id: 's-1', name: 'Plumbing' }]);
      expect(view.avatarUrl).toBeNull();
    });
  });

  describe('changeRole — ported out of PL/pgSQL', () => {
    const membershipRow = (overrides: Record<string, unknown> = {}) => ({
      id: 'membership-1',
      role: 'employee',
      status: 'active',
      manager_id: null,
      ...overrides,
    });

    it('writes the new role, audits it, and reports the real old and new roles', async () => {
      const { tx, queries } = buildMembershipWrite({ member: membershipRow() });
      const { service } = build({ tx });

      await expect(
        service.changeRole(companyAdmin, 'member-1', 'viewer' as never),
      ).resolves.toEqual({
        userId: 'member-1',
        oldRole: 'employee',
        newRole: 'viewer',
      });

      const update = queries.find((q) =>
        q.sql.includes('update public.memberships'),
      );
      expect(update?.params).toEqual(['membership-1', 'viewer', false]);
      const audit = queries.find((q) =>
        q.sql.includes('insert into public.audit_log'),
      );
      expect(audit?.params?.slice(1, 4)).toEqual([
        'tenant-A',
        'member.role_change',
        ['member-1'],
      ]);
    });

    it('promotion to admin clears the member’s own pointer in the same write (D1)', async () => {
      const { tx, queries } = buildMembershipWrite({
        member: membershipRow({ role: 'viewer', manager_id: 'boss-1' }),
      });
      const { service } = build({ tx });

      await service.changeRole(
        companyAdmin,
        'member-1',
        'company_admin' as never,
      );

      const update = queries.find((q) =>
        q.sql.includes('update public.memberships'),
      );
      expect(update?.params).toEqual(['membership-1', 'company_admin', true]);
      const audit = queries.find((q) =>
        q.sql.includes('insert into public.audit_log'),
      );
      expect(String(audit?.params?.[4])).toContain('cleared_manager_id');
    });

    it('24-3: demoting an admin removes them from every fallback-routed pending request', async () => {
      const before = [
        {
          user_id: 'member-1',
          manager_id: null,
          role: 'company_admin',
          status: 'active',
          disabled: false,
        },
        {
          user_id: 'admin-2',
          manager_id: null,
          role: 'company_admin',
          status: 'active',
          disabled: false,
        },
        {
          user_id: 'top-1',
          manager_id: null,
          role: 'employee',
          status: 'active',
          disabled: false,
        },
      ];
      const after = before.map((row) =>
        row.user_id === 'member-1' ? { ...row, role: 'employee' } : row,
      );
      const { tx, queries } = buildMembershipWrite({
        member: membershipRow({ role: 'company_admin', status: 'active' }),
        otherAdmins: 1,
        liveMemberIds: ['member-1', 'admin-2', 'top-1'],
        pendingApprovals: [
          {
            id: 'leave-1',
            request_id: 'req-1',
            employee_id: 'top-1',
            created_by: 'top-1',
            start_date: '2026-12-01',
            end_date: '2026-12-02',
            employee_name: 'Ravi',
          },
        ],
        approvalTrees: [
          before.map((row) => ({ ...row })),
          after.map((row) => ({ ...row })),
          after.map((row) => ({ ...row })),
        ],
      });
      const { service } = build({ tx });

      await service.changeRole(companyAdmin, 'member-1', 'employee' as never);

      const notices = queries.filter((q) =>
        q.sql.includes('insert into public.notifications'),
      );
      expect(notices.map((q) => [q.params?.[2], q.params?.[1]])).toEqual([
        ['leave.approver_removed', 'member-1'],
      ]);
    });

    it('24-4: a demotion removes the demoted admin from a fallback-routed pending job too', async () => {
      const before = [
        {
          user_id: 'member-1',
          manager_id: null,
          role: 'company_admin',
          status: 'active',
          disabled: false,
        },
        {
          user_id: 'admin-2',
          manager_id: null,
          role: 'company_admin',
          status: 'active',
          disabled: false,
        },
        {
          user_id: 'top-1',
          manager_id: null,
          role: 'employee',
          status: 'active',
          disabled: false,
        },
      ];
      const after = before.map((row) =>
        row.user_id === 'member-1' ? { ...row, role: 'employee' } : row,
      );
      const { tx, queries } = buildMembershipWrite({
        member: membershipRow({ role: 'company_admin', status: 'active' }),
        otherAdmins: 1,
        liveMemberIds: ['member-1', 'admin-2', 'top-1'],
        pendingJobs: [
          {
            id: 'job-1',
            job_number: 'JB-2026-0001',
            created_by: 'top-1',
            employee_name: 'Ravi',
            customer_name: 'Asha',
          },
        ],
        approvalTrees: [
          before.map((row) => ({ ...row })),
          after.map((row) => ({ ...row })),
        ],
      });
      const { service } = build({ tx });

      await service.changeRole(companyAdmin, 'member-1', 'employee' as never);

      const notices = queries.filter((q) =>
        q.sql.includes('insert into public.notifications'),
      );
      expect(notices.map((q) => [q.params?.[3], q.params?.[1]])).toEqual([
        ['job.approver_removed', 'member-1'],
      ]);
    });

    it('a same-role call writes nothing and audits nothing', async () => {
      const { tx, queries } = buildMembershipWrite({
        member: membershipRow({ role: 'viewer' }),
      });
      const { service } = build({ tx });

      await expect(
        service.changeRole(companyAdmin, 'member-1', 'viewer' as never),
      ).resolves.toEqual({
        userId: 'member-1',
        oldRole: 'viewer',
        newRole: 'viewer',
      });
      expect(
        queries.some((q) => q.sql.includes('update public.memberships')),
      ).toBe(false);
      expect(
        queries.some((q) => q.sql.includes('insert into public.audit_log')),
      ).toBe(false);
    });

    it('refuses to demote the only active admin — a disabled co-admin does not count', async () => {
      const { tx } = buildMembershipWrite({
        member: membershipRow({ role: 'company_admin', status: 'active' }),
        otherAdmins: 0,
      });
      const { service } = build({ tx });

      const err = await service
        .changeRole(companyAdmin, 'member-1', 'viewer' as never)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(bodyOf(err)).toMatchObject({ error_code: 'LAST_ADMIN' });
    });

    it('lets a platform admin change a role of the named company', async () => {
      const { tx } = buildMembershipWrite({
        caller: {
          platform_admin: true,
          disabled: false,
          is_company_admin: false,
        },
        member: membershipRow(),
      });
      const { service } = build({ tx });

      await expect(
        service.changeRole(staffOnCompany, 'member-1', 'viewer' as never),
      ).resolves.toMatchObject({ newRole: 'viewer' });
    });

    it('refuses a disabled caller, and one who does not manage this company', async () => {
      for (const caller of [
        { platform_admin: false, disabled: true, is_company_admin: true },
        { platform_admin: false, disabled: false, is_company_admin: false },
      ]) {
        const { tx } = buildMembershipWrite({ caller });
        const { service } = build({ tx });

        const err = await service
          .changeRole(companyAdmin, 'member-1', 'viewer' as never)
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ForbiddenException);
        expect(bodyOf(err)).toMatchObject({ error_code: 'FORBIDDEN' });
      }
    });

    it('answers 404 for a member who is not in this company', async () => {
      const { tx } = buildMembershipWrite({ member: null });
      const { service } = build({ tx });

      await expect(
        service.changeRole(companyAdmin, 'ghost', 'viewer' as never),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('refuses to change your own role with 403 FORBIDDEN, before any read', async () => {
      const { tx } = buildMembershipWrite();
      const { service } = build({ tx });

      const err = await service
        .changeRole(companyAdmin, 'admin-1', 'viewer' as never)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(bodyOf(err)).toMatchObject({ error_code: 'FORBIDDEN' });
      expect(tx.query).not.toHaveBeenCalled();
    });

    it('fails the whole change when the audit row cannot be written', async () => {
      const { tx } = buildMembershipWrite({
        member: membershipRow(),
        auditWritten: 0,
      });
      const { service } = build({ tx });

      const err = await service
        .changeRole(companyAdmin, 'member-1', 'viewer' as never)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InternalServerErrorException);
      expect(bodyOf(err)).toMatchObject({
        error_code: 'INTERNAL_SERVER_ERROR',
      });
    });
  });

  describe('remove — ported out of PL/pgSQL', () => {
    const membershipRow = (overrides: Record<string, unknown> = {}) => ({
      id: 'membership-1',
      role: 'employee',
      status: 'active',
      manager_id: null,
      ...overrides,
    });

    it('re-parents direct reports, clears the removed pointer and audits each change', async () => {
      const { tx, queries } = buildMembershipWrite({
        member: membershipRow({ manager_id: 'mgr-1' }),
        managerServes: true,
        reportIds: ['report-1', 'report-2'],
      });
      const { service } = build({ tx });

      await service.remove(companyAdmin, 'member-1');

      const reparent = queries.find((q) => q.sql.includes('returning user_id'));
      expect(reparent?.params).toEqual(['tenant-A', 'member-1', 'mgr-1']);
      const removed = queries.find((q) =>
        q.sql.includes("set status = 'removed'"),
      );
      expect(removed?.params).toEqual(['membership-1']);

      const audits = queries.filter((q) =>
        q.sql.includes('insert into public.audit_log'),
      );
      expect(audits).toHaveLength(2);
      expect(audits[0].params?.slice(1, 4)).toEqual([
        'tenant-A',
        'member.remove',
        ['member-1'],
      ]);
      expect(audits[1].params?.slice(1, 4)).toEqual([
        'tenant-A',
        'member.reparent',
        ['report-1', 'report-2'],
      ]);
    });

    it('24-3: a removal notifies the new approver of a re-parented pending request, never the removed member', async () => {
      const base = [
        {
          user_id: 'admin-1',
          manager_id: null,
          role: 'company_admin',
          status: 'active',
          disabled: false,
        },
        {
          user_id: 'mgr-1',
          manager_id: null,
          role: 'employee',
          status: 'active',
          disabled: false,
        },
        {
          user_id: 'member-1',
          manager_id: 'mgr-1',
          role: 'employee',
          status: 'active',
          disabled: false,
        },
        {
          user_id: 'report-1',
          manager_id: 'member-1',
          role: 'employee',
          status: 'active',
          disabled: false,
        },
      ];
      const after = base.map((row) => {
        if (row.user_id === 'member-1') {
          return {
            ...row,
            status: 'removed',
            manager_id: null,
          };
        }
        return row.user_id === 'report-1'
          ? { ...row, manager_id: 'mgr-1' }
          : row;
      });
      const { tx, queries } = buildMembershipWrite({
        member: membershipRow({ manager_id: 'mgr-1' }),
        managerServes: true,
        reportIds: ['report-1'],
        subtreeIds: ['report-1'],
        pendingApprovals: [
          {
            id: 'leave-1',
            request_id: 'req-1',
            employee_id: 'report-1',
            created_by: 'report-1',
            start_date: '2026-12-01',
            end_date: '2026-12-02',
            employee_name: 'Ravi',
          },
        ],
        approvalTrees: [
          base.map((row) => ({ ...row })),
          after.map((row) => ({ ...row })),
          after.map((row) => ({ ...row })),
        ],
      });
      const { service } = build({ tx });

      await service.remove(companyAdmin, 'member-1');

      const notices = queries.filter((q) =>
        q.sql.includes('insert into public.notifications'),
      );
      // The removed member is no longer active, so their "no longer yours"
      // notice is suppressed; the re-parented request's new approver is told.
      expect(notices.map((q) => [q.params?.[2], q.params?.[1]])).toEqual([
        ['leave.approver_added', 'mgr-1'],
      ]);
    });

    it("24-4: removing a manager moves a report's pending job to the new manager", async () => {
      const base = [
        {
          user_id: 'admin-1',
          manager_id: null,
          role: 'company_admin',
          status: 'active',
          disabled: false,
        },
        {
          user_id: 'mgr-1',
          manager_id: null,
          role: 'employee',
          status: 'active',
          disabled: false,
        },
        {
          user_id: 'member-1',
          manager_id: null,
          role: 'employee',
          status: 'active',
          disabled: false,
        },
        {
          user_id: 'report-1',
          manager_id: 'member-1',
          role: 'employee',
          status: 'active',
          disabled: false,
        },
      ];
      const after = base.map((row) => {
        if (row.user_id === 'member-1') {
          return { ...row, status: 'removed', manager_id: null };
        }
        return row.user_id === 'report-1'
          ? { ...row, manager_id: 'mgr-1' }
          : row;
      });
      const { tx, queries } = buildMembershipWrite({
        member: membershipRow({ manager_id: 'mgr-1' }),
        managerServes: true,
        reportIds: ['report-1'],
        subtreeIds: ['report-1'],
        pendingJobs: [
          {
            id: 'job-1',
            job_number: 'JB-2026-0001',
            created_by: 'report-1',
            employee_name: 'Ravi',
            customer_name: 'Asha',
          },
        ],
        approvalTrees: [
          base.map((row) => ({ ...row })),
          after.map((row) => ({ ...row })),
        ],
      });
      const { service } = build({ tx });

      await service.remove(companyAdmin, 'member-1');

      const notices = queries.filter((q) =>
        q.sql.includes('insert into public.notifications'),
      );
      // The removed member is no longer live, so their "no longer yours" notice
      // is suppressed; the report's new approver is told the job is theirs.
      expect(notices.map((q) => [q.params?.[3], q.params?.[1]])).toEqual([
        ['job.approver_added', 'mgr-1'],
      ]);
    });

    it('24-3: removing a member who has their own pending request notifies nobody', async () => {
      const before = [
        {
          user_id: 'admin-1',
          manager_id: null,
          role: 'company_admin',
          status: 'active',
          disabled: false,
        },
        {
          user_id: 'mgr-1',
          manager_id: null,
          role: 'employee',
          status: 'active',
          disabled: false,
        },
        {
          user_id: 'member-1',
          manager_id: 'mgr-1',
          role: 'employee',
          status: 'active',
          disabled: false,
        },
      ];
      const after = before.map((row) =>
        row.user_id === 'member-1'
          ? { ...row, status: 'removed', manager_id: null }
          : row,
      );
      const { tx, queries } = buildMembershipWrite({
        member: membershipRow({ manager_id: 'mgr-1' }),
        managerServes: true,
        reportIds: [],
        subtreeIds: [],
        pendingApprovals: [
          {
            id: 'leave-1',
            request_id: 'req-1',
            employee_id: 'member-1',
            created_by: 'member-1',
            start_date: '2026-12-01',
            end_date: '2026-12-02',
            employee_name: 'Ravi',
          },
        ],
        approvalTrees: [
          before.map((row) => ({ ...row })),
          after.map((row) => ({ ...row })),
          after.map((row) => ({ ...row })),
        ],
      });
      const { service } = build({ tx });

      await service.remove(companyAdmin, 'member-1');

      expect(
        queries.filter((q) =>
          q.sql.includes('insert into public.notifications'),
        ),
      ).toHaveLength(0);
    });

    it('leaves the reports unassigned when the removed member’s own manager no longer serves', async () => {
      const { tx, queries } = buildMembershipWrite({
        member: membershipRow({ manager_id: 'mgr-1' }),
        managerServes: false,
      });
      const { service } = build({ tx });

      await service.remove(companyAdmin, 'member-1');

      const reparent = queries.find((q) => q.sql.includes('returning user_id'));
      expect(reparent?.params).toEqual(['tenant-A', 'member-1', null]);
    });

    it('writes one audit row when the member has no reports', async () => {
      const { tx, queries } = buildMembershipWrite({
        member: membershipRow(),
        reportIds: [],
      });
      const { service } = build({ tx });

      await service.remove(companyAdmin, 'member-1');

      expect(
        queries.filter((q) => q.sql.includes('insert into public.audit_log')),
      ).toHaveLength(1);
    });

    it('refuses to remove the only active admin', async () => {
      const { tx } = buildMembershipWrite({
        member: membershipRow({ role: 'company_admin', status: 'active' }),
        otherAdmins: 0,
      });
      const { service } = build({ tx });

      const err = await service
        .remove(companyAdmin, 'member-1')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(bodyOf(err)).toMatchObject({ error_code: 'LAST_ADMIN' });
    });

    it('maps a not-found member to 404', async () => {
      const { tx } = buildMembershipWrite({ member: null });
      const { service } = build({ tx });

      await expect(service.remove(companyAdmin, 'ghost')).rejects.toMatchObject(
        { status: 404 },
      );
    });

    it('refuses to remove yourself with 403 FORBIDDEN, before any read', async () => {
      const { tx } = buildMembershipWrite();
      const { service } = build({ tx });

      const err = await service
        .remove(companyAdmin, 'admin-1')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(bodyOf(err)).toMatchObject({ error_code: 'FORBIDDEN' });
      expect(tx.query).not.toHaveBeenCalled();
    });
  });

  describe('setManager — "Reports to"', () => {
    const detailRow = {
      user_id: 'member-1',
      role: 'employee',
      status: 'active',
      employee_code: 'EMP-001',
      created_at: '2026-06-20T00:00:00Z',
      can_create_jobs: false,
      job_approval_required: false,
      users: {
        name: 'Ravi Kumar',
        email: null,
        country_code: '+91',
        phone_number: '9000000000',
        disabled: false,
        avatar_key: null,
      },
    };
    const membershipRow = (overrides: Record<string, unknown> = {}) => ({
      id: 'membership-1',
      role: 'employee',
      manager_id: null,
      ...overrides,
    });
    const managerRow = (overrides: Record<string, unknown> = {}) => ({
      user_id: 'mgr-1',
      status: 'active',
      disabled: false,
      ...overrides,
    });

    it('stores the pointer, audits it and answers the updated member', async () => {
      const { tx, queries } = buildMembershipWrite({
        member: membershipRow(),
        manager: managerRow(),
      });
      const { service } = build({
        tx,
        query: { data: [detailRow], error: null },
      });

      const view = await service.setManager(companyAdmin, 'member-1', 'mgr-1');

      expect(view.userId).toBe('member-1');
      const update = queries.find((q) =>
        q.sql.includes('update public.memberships'),
      );
      expect(update?.params).toEqual(['membership-1', 'mgr-1']);
      const audit = queries.find((q) =>
        q.sql.includes('insert into public.audit_log'),
      );
      expect(audit?.params?.slice(1, 4)).toEqual([
        'tenant-A',
        'member.manager_change',
        ['member-1'],
      ]);
    });

    it('clears the pointer when managerId is null', async () => {
      const { tx, queries } = buildMembershipWrite({
        member: membershipRow({ manager_id: 'mgr-1' }),
      });
      const { service } = build({
        tx,
        query: { data: [detailRow], error: null },
      });

      await service.setManager(companyAdmin, 'member-1', null);

      const update = queries.find((q) =>
        q.sql.includes('update public.memberships'),
      );
      expect(update?.params).toEqual(['membership-1', null]);
    });

    it('refuses to assign a manager to an admin — 409 MEMBER_IS_ADMIN', async () => {
      const { tx } = buildMembershipWrite({
        member: membershipRow({ role: 'company_admin' }),
        manager: managerRow(),
      });
      const { service } = build({ tx });

      const err = await service
        .setManager(companyAdmin, 'member-1', 'mgr-1')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(bodyOf(err)).toMatchObject({ error_code: 'MEMBER_IS_ADMIN' });
    });

    it('refuses a person reporting to themselves — 422', async () => {
      const { tx } = buildMembershipWrite();
      const { service } = build({ tx });

      const err = await service
        .setManager(companyAdmin, 'member-1', 'member-1')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnprocessableEntityException);
      expect(bodyOf(err)).toMatchObject({ error_code: 'VALIDATION_ERROR' });
      expect(tx.query).not.toHaveBeenCalled();
    });

    it('refuses an invited, deactivated or disabled manager — 422 MANAGER_NOT_ACTIVE', async () => {
      for (const manager of [
        managerRow({ status: 'invited' }),
        managerRow({ status: 'deactivated' }),
        managerRow({ disabled: true }),
      ]) {
        const { tx } = buildMembershipWrite({
          member: membershipRow(),
          manager,
        });
        const { service } = build({ tx });

        const err = await service
          .setManager(companyAdmin, 'member-1', 'mgr-1')
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(UnprocessableEntityException);
        expect(bodyOf(err)).toMatchObject({ error_code: 'MANAGER_NOT_ACTIVE' });
      }
    });

    it('answers not found for a manager who is not in this company', async () => {
      const { tx } = buildMembershipWrite({
        member: membershipRow(),
        manager: null,
      });
      const { service } = build({ tx });

      const err = await service
        .setManager(companyAdmin, 'member-1', 'mgr-1')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NotFoundException);
      expect(bodyOf(err)).toMatchObject({ error_code: 'RESOURCE_NOT_FOUND' });
    });

    it('refuses a removed manager — 422 MANAGER_NOT_ACTIVE, same as the other inactive states', async () => {
      const { tx } = buildMembershipWrite({
        member: membershipRow(),
        manager: managerRow({ status: 'removed' }),
      });
      const { service } = build({ tx });

      const err = await service
        .setManager(companyAdmin, 'member-1', 'mgr-1')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnprocessableEntityException);
      expect(bodyOf(err)).toMatchObject({ error_code: 'MANAGER_NOT_ACTIVE' });
    });

    it('accepts an active admin as the manager — anyone may serve (CAP-1)', async () => {
      const { tx } = buildMembershipWrite({
        member: membershipRow(),
        manager: managerRow({ role: 'company_admin' }),
      });
      const { service } = build({
        tx,
        query: { data: [detailRow], error: null },
      });

      await expect(
        service.setManager(companyAdmin, 'member-1', 'mgr-1'),
      ).resolves.toMatchObject({ userId: 'member-1' });
    });

    it('assigns a manager to an invited or deactivated member — only removed is 404', async () => {
      for (const status of ['invited', 'deactivated']) {
        const { tx } = buildMembershipWrite({
          member: membershipRow({ status }),
          manager: managerRow(),
        });
        const { service } = build({
          tx,
          query: { data: [detailRow], error: null },
        });

        await expect(
          service.setManager(companyAdmin, 'member-1', 'mgr-1'),
        ).resolves.toMatchObject({ userId: 'member-1' });
      }
    });

    it('lets an admin clear a stray pointer, but never assign one', async () => {
      const { tx, queries } = buildMembershipWrite({
        member: membershipRow({ role: 'company_admin', manager_id: 'mgr-1' }),
      });
      const { service } = build({
        tx,
        query: { data: [detailRow], error: null },
      });

      await service.setManager(companyAdmin, 'member-1', null);

      const update = queries.find((q) =>
        q.sql.includes('update public.memberships'),
      );
      expect(update?.params).toEqual(['membership-1', null]);
    });

    it('a clear when the pointer is already null writes nothing and audits nothing', async () => {
      const { tx, queries } = buildMembershipWrite({ member: membershipRow() });
      const { service } = build({
        tx,
        query: { data: [detailRow], error: null },
      });

      await service.setManager(companyAdmin, 'member-1', null);

      expect(
        queries.some((q) => q.sql.includes('update public.memberships')),
      ).toBe(false);
      expect(
        queries.some((q) => q.sql.includes('insert into public.audit_log')),
      ).toBe(false);
    });

    it('answers the chain and the headcount from the same write', async () => {
      const { tx } = buildMembershipWrite({
        member: membershipRow(),
        manager: managerRow(),
        hierarchyUp: [
          { node_id: 'member-1', ancestor_id: 'mgr-1', depth: 1, name: 'Mira' },
          {
            node_id: 'member-1',
            ancestor_id: 'owner-1',
            depth: 2,
            name: 'Ovi',
          },
        ],
        hierarchyDown: [
          { root_id: 'member-1', node_id: 'r-1', depth: 1, disabled: false },
          { root_id: 'member-1', node_id: 'r-2', depth: 2, disabled: false },
        ],
      });
      const { service } = build({
        tx,
        query: { data: [detailRow], error: null },
      });

      const view = await service.setManager(companyAdmin, 'member-1', 'mgr-1');

      expect(view).toMatchObject({
        managerId: 'mgr-1',
        managerName: 'Mira',
        chain: [
          { userId: 'mgr-1', name: 'Mira' },
          { userId: 'owner-1', name: 'Ovi' },
        ],
        headcount: 2,
        directReports: 1,
      });
    });

    it('re-checks the caller after the company lock, so a mid-wait demotion cannot write', async () => {
      const { tx, queries } = buildMembershipWrite({
        member: membershipRow(),
        manager: managerRow(),
      });
      const { service } = build({
        tx,
        query: { data: [detailRow], error: null },
      });

      await service.setManager(companyAdmin, 'member-1', 'mgr-1');

      const lockAt = queries.findIndex((q) =>
        q.sql.includes('attendance_lock_tenant'),
      );
      const probes = queries
        .map((q, index) => ({ index, sql: q.sql }))
        .filter((q) => q.sql.includes('as is_company_admin'));
      expect(lockAt).toBeGreaterThanOrEqual(0);
      expect(probes).toHaveLength(2);
      expect(probes[0].index).toBeLessThan(lockAt);
      expect(probes[1].index).toBeGreaterThan(lockAt);
    });

    it('answers 404 for a disabled target instead of writing and then hiding them', async () => {
      const { tx, queries } = buildMembershipWrite({
        member: membershipRow({ disabled: true }),
      });
      const { service } = build({ tx });

      await expect(
        service.setManager(companyAdmin, 'member-1', 'mgr-1'),
      ).rejects.toMatchObject({ status: 404 });
      expect(
        queries.some((q) => q.sql.includes('update public.memberships')),
      ).toBe(false);
    });

    it('refuses a loop — 409 HIERARCHY_CYCLE', async () => {
      const { tx } = buildMembershipWrite({
        member: membershipRow(),
        manager: managerRow(),
        probe: { cycle: true, manager_ancestors: 0, subtree_depth: 0 },
      });
      const { service } = build({ tx });

      const err = await service
        .setManager(companyAdmin, 'member-1', 'mgr-1')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(bodyOf(err)).toMatchObject({ error_code: 'HIERARCHY_CYCLE' });
    });

    it('refuses a branch that would pass 20 levels — 409 HIERARCHY_DEPTH', async () => {
      const { tx } = buildMembershipWrite({
        member: membershipRow(),
        manager: managerRow(),
        probe: { cycle: false, manager_ancestors: 15, subtree_depth: 4 },
      });
      const { service } = build({ tx });

      const err = await service
        .setManager(companyAdmin, 'member-1', 'mgr-1')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(bodyOf(err)).toMatchObject({ error_code: 'HIERARCHY_DEPTH' });
    });

    it('allows a branch that lands exactly on level 20', async () => {
      const { tx } = buildMembershipWrite({
        member: membershipRow(),
        manager: managerRow(),
        probe: { cycle: false, manager_ancestors: 14, subtree_depth: 4 },
      });
      const { service } = build({
        tx,
        query: { data: [detailRow], error: null },
      });

      await expect(
        service.setManager(companyAdmin, 'member-1', 'mgr-1'),
      ).resolves.toMatchObject({ userId: 'member-1' });
    });

    it('24-3: a re-parent emits the set-difference notices to the new and old approvers', async () => {
      const admin = {
        user_id: 'admin-1',
        manager_id: null,
        role: 'company_admin',
        status: 'active',
        disabled: false,
      };
      const before = [
        admin,
        {
          user_id: 'old-manager',
          manager_id: null,
          role: 'employee',
          status: 'active',
          disabled: false,
        },
        {
          user_id: 'mgr-1',
          manager_id: null,
          role: 'employee',
          status: 'active',
          disabled: false,
        },
        {
          user_id: 'member-1',
          manager_id: 'old-manager',
          role: 'employee',
          status: 'active',
          disabled: false,
        },
      ];
      const after = before.map((row) =>
        row.user_id === 'member-1' ? { ...row, manager_id: 'mgr-1' } : row,
      );
      const { tx, queries } = buildMembershipWrite({
        member: membershipRow({ manager_id: 'old-manager' }),
        manager: managerRow(),
        pendingApprovals: [
          {
            id: 'leave-1',
            request_id: 'req-1',
            employee_id: 'member-1',
            created_by: 'member-1',
            start_date: '2026-12-01',
            end_date: '2026-12-02',
            employee_name: 'Ravi',
          },
        ],
        approvalTrees: [
          before.map((row) => ({ ...row })),
          after.map((row) => ({ ...row })),
          after.map((row) => ({ ...row })),
        ],
      });
      const { service } = build({
        tx,
        query: { data: [detailRow], error: null },
      });

      await service.setManager(companyAdmin, 'member-1', 'mgr-1');

      const notices = queries.filter((q) =>
        q.sql.includes('insert into public.notifications'),
      );
      const byEvent = new Map(
        notices.map((q) => [q.params?.[2], q.params?.[1]]),
      );
      expect(byEvent.get('leave.approver_added')).toBe('mgr-1');
      expect(byEvent.get('leave.approver_removed')).toBe('old-manager');
    });

    it('24-4: a re-parent emits the set-difference notices for a pending job too', async () => {
      const admin = {
        user_id: 'admin-1',
        manager_id: null,
        role: 'company_admin',
        status: 'active',
        disabled: false,
      };
      const before = [
        admin,
        {
          user_id: 'old-manager',
          manager_id: null,
          role: 'employee',
          status: 'active',
          disabled: false,
        },
        {
          user_id: 'mgr-1',
          manager_id: null,
          role: 'employee',
          status: 'active',
          disabled: false,
        },
        {
          user_id: 'member-1',
          manager_id: 'old-manager',
          role: 'employee',
          status: 'active',
          disabled: false,
        },
      ];
      const after = before.map((row) =>
        row.user_id === 'member-1' ? { ...row, manager_id: 'mgr-1' } : row,
      );
      const { tx, queries } = buildMembershipWrite({
        member: membershipRow({ manager_id: 'old-manager' }),
        manager: managerRow(),
        subtreeIds: [],
        pendingJobs: [
          {
            id: 'job-1',
            job_number: 'JB-2026-0001',
            created_by: 'member-1',
            employee_name: 'Ravi',
            customer_name: 'Asha',
          },
        ],
        approvalTrees: [
          before.map((row) => ({ ...row })),
          after.map((row) => ({ ...row })),
        ],
      });
      const { service } = build({
        tx,
        query: { data: [detailRow], error: null },
      });

      await service.setManager(companyAdmin, 'member-1', 'mgr-1');

      const notices = queries.filter((q) =>
        q.sql.includes('insert into public.notifications'),
      );
      expect(notices.map((q) => [q.params?.[3], q.params?.[1]])).toEqual([
        ['job.approver_added', 'mgr-1'],
        ['job.approver_removed', 'old-manager'],
      ]);
      expect(JSON.parse(notices[0].params?.[4] as string)).toMatchObject({
        job_number: 'JB-2026-0001',
        customer_name: 'Asha',
        employee_name: 'Ravi',
      });
      // Producer → consumer: the same payload the bell row carries must give
      // the push sweep a real body (snake_case keys, not camelCase).
      const push = pushCopyForEvent(
        'job.approver_added',
        JSON.parse(notices[0].params?.[4] as string) as Record<string, unknown>,
      );
      expect(push.body).toContain('JB-2026-0001');
      expect(push.body).toContain('Asha');
      expect(push.body).toContain('Ravi');
    });

    it('24-4: an admin who makes themself the manager is not notified about the job they took over', async () => {
      const before = [
        {
          user_id: 'admin-1',
          manager_id: null,
          role: 'company_admin',
          status: 'active',
          disabled: false,
        },
        {
          user_id: 'old-manager',
          manager_id: null,
          role: 'employee',
          status: 'active',
          disabled: false,
        },
        {
          user_id: 'member-1',
          manager_id: 'old-manager',
          role: 'employee',
          status: 'active',
          disabled: false,
        },
      ];
      const after = before.map((row) =>
        row.user_id === 'member-1' ? { ...row, manager_id: 'admin-1' } : row,
      );
      const { tx, queries } = buildMembershipWrite({
        member: membershipRow({ manager_id: 'old-manager' }),
        manager: managerRow(),
        pendingJobs: [
          {
            id: 'job-1',
            job_number: 'JB-2026-0001',
            created_by: 'member-1',
            employee_name: 'Ravi',
            customer_name: 'Asha',
          },
        ],
        approvalTrees: [
          before.map((row) => ({ ...row })),
          after.map((row) => ({ ...row })),
        ],
      });
      const { service } = build({
        tx,
        query: { data: [detailRow], error: null },
      });

      await service.setManager(companyAdmin, 'member-1', 'admin-1');

      const notices = queries.filter((q) =>
        q.sql.includes('insert into public.notifications'),
      );
      // The old manager hears it moved; the admin who performed the write does
      // not ring their own bell for the job they just took over.
      expect(notices.map((q) => [q.params?.[3], q.params?.[1]])).toEqual([
        ['job.approver_removed', 'old-manager'],
      ]);
    });

    it('a same-manager call writes nothing and audits nothing', async () => {
      const { tx, queries } = buildMembershipWrite({
        member: membershipRow({ manager_id: 'mgr-1' }),
        manager: managerRow(),
      });
      const { service } = build({
        tx,
        query: { data: [detailRow], error: null },
      });

      await service.setManager(companyAdmin, 'member-1', 'mgr-1');

      expect(
        queries.some((q) => q.sql.includes('update public.memberships')),
      ).toBe(false);
      expect(
        queries.some((q) => q.sql.includes('insert into public.audit_log')),
      ).toBe(false);
    });

    it('answers 404 for a removed target member', async () => {
      const { tx } = buildMembershipWrite({ member: null });
      const { service } = build({ tx });

      await expect(
        service.setManager(companyAdmin, 'member-1', 'mgr-1'),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('refuses a caller who does not manage this company', async () => {
      const { tx } = buildMembershipWrite({
        caller: {
          platform_admin: false,
          disabled: false,
          is_company_admin: false,
        },
      });
      const { service } = build({ tx });

      const err = await service
        .setManager(companyAdmin, 'member-1', 'mgr-1')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(bodyOf(err)).toMatchObject({ error_code: 'FORBIDDEN' });
    });
  });

  describe('setDisabled', () => {
    it('disables a person and says so', async () => {
      const { service, rpc } = build({ rpc: { data: true, error: null } });
      await expect(
        service.setDisabled(platformAdmin, 'person-1', true),
      ).resolves.toEqual({ userId: 'person-1', disabled: true });
      expect(rpc).toHaveBeenCalledWith('set_user_disabled', {
        p_caller: 'staff-1',
        p_user_id: 'person-1',
        p_disabled: true,
      });
    });

    it('enables a person and says so (the database returns false)', async () => {
      const { service } = build({ rpc: { data: false, error: null } });
      await expect(
        service.setDisabled(platformAdmin, 'person-1', false),
      ).resolves.toEqual({ userId: 'person-1', disabled: false });
    });

    it('never reports disabled when the database gives a value other than true', async () => {
      const { service } = build({ rpc: { data: null, error: null } });
      await expect(
        service.setDisabled(platformAdmin, 'person-1', true),
      ).resolves.toEqual({ userId: 'person-1', disabled: false });
    });

    it('refuses to disable the last active admin with a 409 and the LAST_ADMIN code', async () => {
      const { service } = build({
        rpc: {
          data: null,
          error: { code: 'PT409', hint: 'LAST_ADMIN', message: 'x' },
        },
      });
      const err = await service
        .setDisabled(platformAdmin, 'admin-1', true)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(bodyOf(err)).toMatchObject({ error_code: 'LAST_ADMIN' });
    });
  });

  describe('auditLog', () => {
    it('reads only the caller company for a company admin', async () => {
      const { service, query } = build();
      await service.auditLog(companyAdmin, undefined, undefined);
      expect(query.calls).toContainEqual(['eq', ['tenant_id', 'tenant-A']]);
    });

    it('cannot be widened by the caller: a company admin is always scoped', async () => {
      const { service, query } = build();
      await service.auditLog(
        { ...companyAdmin, tenantId: 'tenant-A' },
        undefined,
        undefined,
      );
      const tenantFilters = query.calls.filter(
        ([name, args]) => name === 'eq' && args[0] === 'tenant_id',
      );
      expect(tenantFilters).toHaveLength(1);
    });

    it('a platform admin who named a company sees only that company', async () => {
      const { service, query } = build();
      await service.auditLog(
        { ...platformAdmin, tenantId: 'tenant-B' },
        undefined,
        undefined,
      );
      expect(query.calls).toContainEqual(['eq', ['tenant_id', 'tenant-B']]);
    });

    it('a platform admin who named no company sees every company', async () => {
      const { service, query } = build();
      await service.auditLog(platformAdmin, undefined, undefined);
      expect(query.calls.map(([name]) => name)).not.toContain('eq');
    });

    it('returns 50 rows by default and never more than the limit asked for', async () => {
      const { service, query } = build();
      await service.auditLog(companyAdmin, undefined, undefined);
      expect(query.calls).toContainEqual(['limit', [50]]);
      await service.auditLog(companyAdmin, 7, undefined);
      expect(query.calls).toContainEqual(['limit', [7]]);
    });

    it('orders newest first, with id as the tie-breaker', async () => {
      const { service, query } = build();
      await service.auditLog(companyAdmin, undefined, undefined);
      expect(query.calls).toContainEqual([
        'order',
        ['created_at', { ascending: false }],
      ]);
      expect(query.calls).toContainEqual([
        'order',
        ['id', { ascending: false }],
      ]);
    });

    it('rejects a beforeId sent without before, rather than ignoring it', async () => {
      const { service, from } = build();
      const err = await service
        .auditLog(
          companyAdmin,
          undefined,
          undefined,
          '11111111-1111-1111-1111-111111111111',
        )
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(bodyOf(err)).toMatchObject({ error_code: 'VALIDATION_ERROR' });
      expect(from).not.toHaveBeenCalled();
    });

    it('pages by timestamp when only before is sent', async () => {
      const { service, query } = build();
      await service.auditLog(companyAdmin, undefined, '2026-10-01T00:00:00Z');
      expect(query.calls).toContainEqual([
        'lt',
        ['created_at', '2026-10-01T00:00:00Z'],
      ]);
    });

    it('pages by (timestamp, id) when both are sent, so same-second rows are not skipped', async () => {
      const { service, query } = build();
      await service.auditLog(
        companyAdmin,
        undefined,
        '2026-10-01T00:00:00Z',
        '22222222-2222-2222-2222-222222222222',
      );
      expect(query.calls).toContainEqual([
        'or',
        [
          'created_at.lt."2026-10-01T00:00:00Z",and(created_at.eq."2026-10-01T00:00:00Z",id.lt.22222222-2222-2222-2222-222222222222)',
        ],
      ]);
    });

    it('maps each row, defaulting a missing target and details', async () => {
      const { service } = build({
        query: {
          data: [
            {
              id: 'a-1',
              created_at: '2026-10-01T00:00:00Z',
              actor_user_id: 'admin-1',
              actor_is_platform_admin: false,
              tenant_id: 'tenant-A',
              action: 'member.remove',
              target_user_id: null,
              details: null,
            },
          ],
          error: null,
        },
      });
      await expect(
        service.auditLog(companyAdmin, undefined, undefined),
      ).resolves.toEqual([
        {
          id: 'a-1',
          createdAt: '2026-10-01T00:00:00Z',
          actorUserId: 'admin-1',
          actorIsPlatformAdmin: false,
          tenantId: 'tenant-A',
          action: 'member.remove',
          targetUserId: null,
          details: {},
        },
      ]);
    });

    it('answers a read failure with a generic 500', async () => {
      const { service } = build({
        query: { data: null, error: { code: '57P01', message: 'boom' } },
      });
      const err = await service
        .auditLog(companyAdmin, undefined, undefined)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InternalServerErrorException);
      expect(bodyOf(err)).toMatchObject({
        error_code: 'INTERNAL_SERVER_ERROR',
      });
    });
  });

  describe('employment (CAP-13)', () => {
    /**
     * The employment endpoints talk to the memberships TABLE (not a database
     * function). This stand-in recognises each builder by what it does — a
     * write is an update, a `select('user_id')` is the employee-code probe,
     * anything else is the row read — and answers with the matching result.
     */
    function buildEmployment(
      opts: {
        row?: Record<string, unknown> | null;
        probeRow?: { user_id: string } | null;
        updateResult?: Record<string, unknown> | null;
        updateError?: { code?: string; message?: string } | null;
        rpcResult?: { data: unknown; error: unknown };
        rpcRejects?: unknown;
      } = {},
    ) {
      const updatesPayloads: Array<Record<string, unknown>> = [];
      const stepLog: string[] = [];

      const mkBuilder = () => {
        const b: Record<string, unknown> = {};
        let selectArg: unknown = null;
        let updated = false;
        for (const name of ['eq', 'neq', 'in', 'order', 'limit', 'lt', 'or']) {
          b[name] = jest.fn((...args: unknown[]) => {
            stepLog.push(`${name}(${JSON.stringify(args)})`);
            return b;
          });
        }
        b['select'] = jest.fn((...args: unknown[]) => {
          selectArg = args[0];
          stepLog.push(`select(${JSON.stringify(args)})`);
          return b;
        });
        b['update'] = jest.fn((payload: Record<string, unknown>) => {
          updated = true;
          stepLog.push(`update(${JSON.stringify(payload)})`);
          updatesPayloads.push(payload);
          return b;
        });
        b['maybeSingle'] = jest.fn(() => b);
        b['single'] = jest.fn(() => b);
        b['then'] = (resolve: (v: unknown) => void) => {
          if (updated) {
            resolve({
              data: opts.updateResult ?? null,
              error: opts.updateError ?? null,
            });
            return;
          }
          if (selectArg === 'user_id') {
            resolve({ data: opts.probeRow ?? null, error: null });
            return;
          }
          resolve({ data: opts.row ?? null, error: null });
        };
        return b;
      };

      const from = jest.fn(() => mkBuilder());
      const rpc =
        opts.rpcRejects !== undefined
          ? jest.fn().mockRejectedValue(opts.rpcRejects)
          : jest
              .fn()
              .mockResolvedValue(opts.rpcResult ?? { data: null, error: null });
      const admin = { from, rpc };
      const factory = {
        createAdmin: jest.fn(() => admin),
      } as unknown as jest.Mocked<SupabaseClientFactory>;
      const storage = {
        presignReadUrl: jest.fn(),
      };
      const service = new MembersService(
        factory,
        storage as unknown as StorageService,
      );
      return { service, from, rpc, updatesPayloads, stepLog };
    }

    const employmentRow = (
      overrides: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
      user_id: 'member-1',
      employee_code: 'EMP-001',
      join_date: '2026-09-01',
      exit_date: null,
      pan: null,
      date_of_birth: null,
      father_name: null,
      mother_name: null,
      spouse_name: null,
      pf_account_number: null,
      uan_number: null,
      designation: null,
      department: null,
      bank_account_number: null,
      ifsc_code: null,
      bank_name: null,
      ...overrides,
    });

    const employmentErrorOf = async (
      run: () => Promise<unknown>,
    ): Promise<{ status: number; body: Record<string, unknown> }> => {
      const err = await run().catch((e: unknown) => e);
      return {
        status: (err as { status?: number }).status ?? 0,
        body: bodyOf(err) as Record<string, unknown>,
      };
    };

    it('get — answers the whole Form V field set, names mapped from the columns', async () => {
      const { service } = buildEmployment({
        row: employmentRow({
          pan: 'ABCPE1234F',
          designation: 'Field Technician',
        }),
      });
      await expect(
        service.getEmployment(companyAdmin, 'member-1'),
      ).resolves.toMatchObject({
        userId: 'member-1',
        employeeCode: 'EMP-001',
        joinDate: '2026-09-01',
        pan: 'ABCPE1234F',
        designation: 'Field Technician',
        bankName: null,
      });
    });

    it('get — reads by user AND company with no status filter, so a removed member is served', async () => {
      const { service, stepLog } = buildEmployment({ row: employmentRow() });
      await service.getEmployment(companyAdmin, 'member-1');
      expect(stepLog.join('\n')).toContain(
        JSON.stringify(['user_id', 'member-1']),
      );
      expect(stepLog.join('\n')).toContain(
        JSON.stringify(['tenant_id', 'tenant-A']),
      );
      expect(stepLog.join('\n')).not.toContain('neq');
    });

    it('get — answers 404 when the person is not a member of the caller company', async () => {
      const { service } = buildEmployment({ row: null });
      const { status, body } = await employmentErrorOf(() =>
        service.getEmployment(companyAdmin, 'stranger-1'),
      );
      expect(status).toBe(404);
      expect(body).toMatchObject({ error_code: 'RESOURCE_NOT_FOUND' });
    });

    it('a caller with no company is refused before any read', async () => {
      const { service, from } = buildEmployment({ row: employmentRow() });
      const { status } = await employmentErrorOf(() =>
        service.getEmployment({ ...companyAdmin, tenantId: null }, 'member-1'),
      );
      expect(status).toBe(400);
      expect(from).not.toHaveBeenCalled();
    });

    it('saves the full Form V set and writes exactly one audit entry naming the fields, never the values', async () => {
      const saved = employmentRow({
        pan: 'ABCPE1234F',
        date_of_birth: '1995-04-12',
        father_name: 'Ramesh Sharma',
        pf_account_number: 'PY/ABC/12345/000',
        uan_number: '101234567890',
        designation: 'Field Technician',
        department: 'Field Operations',
        bank_account_number: '1234567890',
        ifsc_code: 'HDFC0001234',
        bank_name: 'HDFC Bank',
      });
      const { service, rpc, updatesPayloads } = buildEmployment({
        row: employmentRow(),
        updateResult: saved,
      });
      await service.updateEmployment(companyAdmin, 'member-1', fullFormV);
      expect(rpc).toHaveBeenCalledTimes(1);
      const call = rpc.mock.calls[0] as unknown as [
        string,
        Record<string, unknown>,
      ];
      expect(call[0]).toBe('write_audit_row');
      expect(call[1].p_action).toBe('member.employment_update');
      expect(call[1].p_target_user).toBe('member-1');
      const details = call[1].p_details as Record<string, unknown>;
      expect(details['changed_fields']).toEqual(
        expect.arrayContaining([
          'pan',
          'date_of_birth',
          'father_name',
          'bank_name',
        ]),
      );
      expect(details['old_employee_code']).toBe('EMP-001');
      expect(details['new_employee_code']).toBe('EMP-001');
      expect(JSON.stringify(details)).not.toContain('ABCPE1234F');
      expect(JSON.stringify(details)).not.toContain('Ramesh');
      // The write itself carries every field — the column names, not the DTO keys.
      const payload = updatesPayloads[0];
      expect(payload).toMatchObject({
        pan: 'ABCPE1234F',
        date_of_birth: '1995-04-12',
        father_name: 'Ramesh Sharma',
        bank_account_number: '1234567890',
        ifsc_code: 'HDFC0001234',
      });
      expect(payload).not.toHaveProperty('pan2');
      expect(payload).not.toHaveProperty('dateOfBirth');
    });

    it('an identical repeat save writes no audit row and no update', async () => {
      const { service, rpc, from } = buildEmployment({
        row: employmentRow({
          pan: 'ABCPE1234F',
          father_name: 'Ramesh Sharma',
        }),
      });
      await service.updateEmployment(companyAdmin, 'member-1', {
        pan: 'ABCPE1234F',
        fatherName: 'Ramesh Sharma',
      });
      expect(from).toHaveBeenCalledTimes(1); // the read only
      expect(rpc).not.toHaveBeenCalled();
    });

    it('null clears a value; an absent key leaves it alone', async () => {
      const { service, updatesPayloads } = buildEmployment({
        row: employmentRow({ father_name: 'Ramesh Sharma' }),
        updateResult: employmentRow({ father_name: null }),
      });
      await service.updateEmployment(companyAdmin, 'member-1', {
        fatherName: null,
      });
      expect(updatesPayloads[0]).toEqual({ father_name: null });

      const second = buildEmployment({
        row: employmentRow({ father_name: 'Ramesh Sharma' }),
        updateResult: employmentRow(),
      });
      await second.service.updateEmployment(companyAdmin, 'member-1', {
        pan: 'ABCPE1234F',
      });
      expect(second.updatesPayloads[0]).toEqual({ pan: 'ABCPE1234F' });
    });

    it('values are trimmed; empty after the trim is a clear', async () => {
      const { service, updatesPayloads } = buildEmployment({
        row: employmentRow({
          designation: null,
          department: 'Field Operations',
        }),
        updateResult: employmentRow(),
      });
      await service.updateEmployment(companyAdmin, 'member-1', {
        designation: '  Field Technician  ',
        department: '   ',
      });
      expect(updatesPayloads[0]).toEqual({
        designation: 'Field Technician',
        department: null,
      });
    });

    it('clearing the join date is allowed — the skip path stays real', async () => {
      const { service, updatesPayloads, rpc } = buildEmployment({
        row: employmentRow({ join_date: '2026-09-01' }),
        updateResult: employmentRow({ join_date: null }),
      });
      await expect(
        service.updateEmployment(companyAdmin, 'member-1', { joinDate: null }),
      ).resolves.toMatchObject({ joinDate: null });
      expect(updatesPayloads[0]).toEqual({ join_date: null });
      expect(rpc).toHaveBeenCalledTimes(1);
    });

    it('validation order — an invented calendar date is called out before anything else', async () => {
      const { service } = buildEmployment({ row: employmentRow() });
      const { status, body } = await employmentErrorOf(() =>
        service.updateEmployment(companyAdmin, 'member-1', {
          joinDate: '2026-02-30',
          employeeCode: null,
        }),
      );
      expect(status).toBe(422);
      expect(String(body['message'])).toContain('joinDate');
      expect(String(body['message'])).not.toContain('employee code');
    });

    it('validation order — a cleared employee code is refused before the join/exit rules', async () => {
      const { service } = buildEmployment({ row: employmentRow() });
      const { status, body } = await employmentErrorOf(() =>
        service.updateEmployment(companyAdmin, 'member-1', {
          employeeCode: null,
          exitDate: '2026-01-01',
        }),
      );
      expect(status).toBe(422);
      expect(String(body['message'])).toContain('permanent');
      expect(String(body['message'])).not.toContain('exit');
    });

    it('an exit needs a join — judged on the state after this save', async () => {
      const { service } = buildEmployment({
        row: employmentRow({ join_date: null }),
      });
      const { status, body } = await employmentErrorOf(() =>
        service.updateEmployment(companyAdmin, 'member-1', {
          exitDate: '2026-09-01',
        }),
      );
      expect(status).toBe(422);
      expect(String(body['message'])).toContain('joining date');
    });

    it('clearing the join and setting an exit in one request is the same refusal', async () => {
      const { service } = buildEmployment({
        row: employmentRow({ join_date: '2026-10-01' }),
      });
      const { status, body } = await employmentErrorOf(() =>
        service.updateEmployment(companyAdmin, 'member-1', {
          joinDate: null,
          exitDate: '2026-09-01',
        }),
      );
      expect(status).toBe(422);
      expect(String(body['message'])).toContain('joining date');
    });

    it('an exit before the join is refused', async () => {
      const { service } = buildEmployment({
        row: employmentRow({ join_date: '2026-10-01' }),
      });
      const { status, body } = await employmentErrorOf(() =>
        service.updateEmployment(companyAdmin, 'member-1', {
          exitDate: '2026-09-01',
        }),
      );
      expect(status).toBe(422);
      expect(String(body['message'])).toContain('cannot be before');
    });

    it('a clash found by the probe answers 409 naming the code, and never writes', async () => {
      const { service, from, stepLog } = buildEmployment({
        row: employmentRow(),
        probeRow: { user_id: 'other-member' },
      });
      const { status, body } = await employmentErrorOf(() =>
        service.updateEmployment(companyAdmin, 'member-1', {
          employeeCode: 'EMP-002',
        }),
      );
      expect(status).toBe(409);
      expect(body).toMatchObject({ error_code: 'DUPLICATE_RESOURCE' });
      expect(String(body['message'])).toContain('EMP-002');
      expect(from).toHaveBeenCalledTimes(2); // read + probe, no write
      expect(stepLog.join('\n')).not.toContain('.update(');
    });

    it('a 23505 unique violation that slips past the probe still answers the 409', async () => {
      const { service } = buildEmployment({
        row: employmentRow(),
        updateError: {
          code: '23505',
          message:
            'duplicate key value violates unique constraint "memberships_tenant_employee_code_key"',
        },
      });
      const { status, body } = await employmentErrorOf(() =>
        service.updateEmployment(companyAdmin, 'member-1', {
          employeeCode: 'EMP-002',
        }),
      );
      expect(status).toBe(409);
      expect(body).toMatchObject({ error_code: 'DUPLICATE_RESOURCE' });
      expect(String(body['message'])).toContain('EMP-002');
    });

    it('a failed audit write that RESOLVES with an error still saves', async () => {
      const { service } = buildEmployment({
        row: employmentRow(),
        updateResult: employmentRow({ designation: 'Field Technician' }),
        rpcResult: {
          data: null,
          error: { code: 'PT403', message: 'forbidden' },
        },
      });
      await expect(
        service.updateEmployment(companyAdmin, 'member-1', {
          designation: 'Field Technician',
        }),
      ).resolves.toMatchObject({ designation: 'Field Technician' });
    });

    it('a REJECTED audit write (network) still saves too', async () => {
      const { service } = buildEmployment({
        row: employmentRow(),
        updateResult: employmentRow({ designation: 'Field Technician' }),
        rpcRejects: new Error('network down'),
      });
      await expect(
        service.updateEmployment(companyAdmin, 'member-1', {
          designation: 'Field Technician',
        }),
      ).resolves.toMatchObject({ designation: 'Field Technician' });
    });

    it('a member deleted between the read and the write answers 404, not a 500', async () => {
      const { service } = buildEmployment({
        row: employmentRow(),
        updateError: { code: 'PGRST116', message: 'no rows returned' },
      });
      const { status, body } = await employmentErrorOf(() =>
        service.updateEmployment(companyAdmin, 'member-1', {
          designation: 'Field Technician',
        }),
      );
      expect(status).toBe(404);
      expect(body).toMatchObject({ error_code: 'RESOURCE_NOT_FOUND' });
    });

    it('a CHECK the write tripped on a stale read answers 409 with a reload hint', async () => {
      const { service } = buildEmployment({
        row: employmentRow(),
        updateError: { code: '23514', message: 'check constraint violated' },
      });
      const { status, body } = await employmentErrorOf(() =>
        service.updateEmployment(companyAdmin, 'member-1', {
          exitDate: '2026-10-10',
        }),
      );
      expect(status).toBe(409);
      expect(body).toMatchObject({ error_code: 'EMPLOYMENT_RECORD_CHANGED' });
      expect(String(body['message'])).toContain('changed since it was read');
    });
  });

  describe('setActive — park / reinstate a member', () => {
    /**
     * setActive runs ONE pg transaction (the employment describe's table
     * cousin): the stand-in dispatches on the SQL shape — the exclusive
     * tenant lock, the `for update` membership read, the last-admin count
     * and the guarded UPDATE — never on call order.
     */
    function buildSetActive(
      opts: {
        memberRow?: Record<string, unknown> | null;
        otherAdmins?: number;
        updateRowCount?: number;
        rpcResult?: { data: unknown; error: unknown };
        liveMemberIds?: string[];
        subtreeIds?: string[];
        pendingApprovals?: Array<Record<string, unknown>>;
        pendingJobs?: Array<Record<string, unknown>>;
        approvalTrees?: unknown[][];
      } = {},
    ) {
      const queries: { sql: string; params?: unknown[] }[] = [];
      const tx = {
        query: jest.fn((sql: string, params?: unknown[]) => {
          queries.push({ sql, params });
          if (sql.includes('attendance_lock_tenant')) return { rows: [] };
          if (sql.includes('with recursive down')) {
            return {
              rows: (opts.subtreeIds ?? []).map((user_id) => ({ user_id })),
            };
          }
          if (sql.includes('select r.id, r.request_id, r.employee_id')) {
            return { rows: opts.pendingApprovals ?? [] };
          }
          if (
            sql.includes('from public.jobs j') &&
            sql.includes("status = 'pending_approval'")
          ) {
            return { rows: opts.pendingJobs ?? [] };
          }
          if (sql.includes('m.role::text')) {
            return { rows: opts.approvalTrees?.shift() ?? [] };
          }
          if (sql.includes('select m.user_id from public.memberships m')) {
            return {
              rows: (opts.liveMemberIds ?? []).map((user_id) => ({ user_id })),
            };
          }
          if (sql.includes('for update'))
            return { rows: opts.memberRow ? [opts.memberRow] : [] };
          if (sql.includes('count(*)::int'))
            return { rows: [{ n: opts.otherAdmins ?? 0 }] };
          if (sql.includes('insert into public.notifications')) {
            return { rowCount: 1, rows: [] };
          }
          if (sql.includes('update public.memberships'))
            return {
              rowCount: opts.updateRowCount ?? 1,
              rows: [{ status: 'set' }],
            };
          throw new Error(`unclassified query: ${sql}`);
        }),
      };
      const pg = {
        withTransaction: (work: (client: unknown) => Promise<unknown>) =>
          work(tx),
      } as unknown as PgPoolFactory;
      const factory = {
        createAdmin: jest.fn(() => admin),
      } as unknown as jest.Mocked<SupabaseClientFactory>;
      const rpc = jest
        .fn()
        .mockResolvedValue(opts.rpcResult ?? { data: null, error: null });
      const admin = { rpc };
      const storage = { presignReadUrl: jest.fn() };
      const service = new MembersService(
        factory,
        storage as unknown as StorageService,
        pg,
      );
      return { service, tx, queries, rpc };
    }

    const membershipRow = (
      overrides: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
      status: 'active',
      role: 'employee',
      employee_code: 'EMP-001',
      ...overrides,
    });

    it('refuses to change your own access with 403 MEMBERSHIP_SELF, before any read', async () => {
      const { service, tx } = buildSetActive();

      const err = await service
        .setActive(companyAdmin, 'admin-1', false)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ForbiddenException);
      expect(bodyOf(err)).toMatchObject({ error_code: 'MEMBERSHIP_SELF' });
      expect(tx.query).not.toHaveBeenCalled();
    });

    it('answers 404 RESOURCE_NOT_FOUND for a person who is not a member of this company', async () => {
      const { service } = buildSetActive({ memberRow: null });

      const err = await service
        .setActive(companyAdmin, 'stranger-1', false)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(NotFoundException);
      expect(bodyOf(err)).toMatchObject({ error_code: 'RESOURCE_NOT_FOUND' });
    });

    it('deactivating someone who is not active answers 409 MEMBERSHIP_STATE — a move only leaves the state it names', async () => {
      const { service } = buildSetActive({
        memberRow: membershipRow({ status: 'invited' }),
      });

      const err = await service
        .setActive(companyAdmin, 'member-1', false)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect(bodyOf(err)).toMatchObject({
        error_code: 'MEMBERSHIP_STATE',
        message: 'Only an active member can be deactivated',
      });
    });

    it('reinstating someone who is not deactivated answers the same 409, with its own message', async () => {
      const { service } = buildSetActive({ memberRow: membershipRow() });

      const err = await service
        .setActive(companyAdmin, 'member-1', true)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect(bodyOf(err)).toMatchObject({
        error_code: 'MEMBERSHIP_STATE',
        message: 'Only a deactivated member can be reinstated',
      });
    });

    it('deactivating the last active admin answers 409 LAST_ADMIN', async () => {
      const { service } = buildSetActive({
        memberRow: membershipRow({ role: 'company_admin' }),
        otherAdmins: 0,
      });

      const err = await service
        .setActive(companyAdmin, 'member-1', false)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect(bodyOf(err)).toMatchObject({ error_code: 'LAST_ADMIN' });
    });

    it('a second active admin exists — the deactivation proceeds', async () => {
      const { service } = buildSetActive({
        memberRow: membershipRow({ role: 'company_admin' }),
        otherAdmins: 1,
      });

      await expect(
        service.setActive(companyAdmin, 'member-1', false),
      ).resolves.toMatchObject({ status: 'deactivated' });
    });

    it('24-3: deactivating a manager hands their pending request to the manager above, without notifying the parked member', async () => {
      const before = [
        {
          user_id: 'admin-1',
          manager_id: null,
          role: 'company_admin',
          status: 'active',
          disabled: false,
        },
        {
          user_id: 'mgr-1',
          manager_id: null,
          role: 'employee',
          status: 'active',
          disabled: false,
        },
        {
          user_id: 'mgr-2',
          manager_id: 'mgr-1',
          role: 'employee',
          status: 'active',
          disabled: false,
        },
        {
          user_id: 'report-1',
          manager_id: 'mgr-2',
          role: 'employee',
          status: 'active',
          disabled: false,
        },
      ];
      const after = before.map((row) =>
        row.user_id === 'mgr-2' ? { ...row, status: 'deactivated' } : row,
      );
      const { service, queries } = buildSetActive({
        memberRow: membershipRow({ role: 'employee' }),
        subtreeIds: ['report-1'],
        pendingApprovals: [
          {
            id: 'leave-1',
            request_id: 'req-1',
            employee_id: 'report-1',
            created_by: 'report-1',
            start_date: '2026-12-01',
            end_date: '2026-12-02',
            employee_name: 'Ravi',
          },
        ],
        approvalTrees: [
          before.map((row) => ({ ...row })),
          after.map((row) => ({ ...row })),
          after.map((row) => ({ ...row })),
        ],
      });

      await service.setActive(companyAdmin, 'mgr-2', false);

      const notices = queries.filter((q) =>
        q.sql.includes('insert into public.notifications'),
      );
      expect(notices.map((q) => [q.params?.[2], q.params?.[1]])).toEqual([
        ['leave.approver_added', 'mgr-1'],
      ]);
    });

    it("24-4: deactivating a manager hands their report's pending job to the manager above", async () => {
      const before = [
        {
          user_id: 'admin-1',
          manager_id: null,
          role: 'company_admin',
          status: 'active',
          disabled: false,
        },
        {
          user_id: 'mgr-1',
          manager_id: null,
          role: 'employee',
          status: 'active',
          disabled: false,
        },
        {
          user_id: 'mgr-2',
          manager_id: 'mgr-1',
          role: 'employee',
          status: 'active',
          disabled: false,
        },
        {
          user_id: 'report-1',
          manager_id: 'mgr-2',
          role: 'employee',
          status: 'active',
          disabled: false,
        },
      ];
      const after = before.map((row) =>
        row.user_id === 'mgr-2' ? { ...row, status: 'deactivated' } : row,
      );
      const { service, queries } = buildSetActive({
        memberRow: membershipRow({ role: 'employee' }),
        subtreeIds: ['report-1'],
        pendingJobs: [
          {
            id: 'job-1',
            job_number: 'JB-2026-0001',
            created_by: 'report-1',
            employee_name: 'Ravi',
            customer_name: 'Asha',
          },
        ],
        approvalTrees: [
          before.map((row) => ({ ...row })),
          after.map((row) => ({ ...row })),
        ],
      });

      await service.setActive(companyAdmin, 'mgr-2', false);

      const notices = queries.filter((q) =>
        q.sql.includes('insert into public.notifications'),
      );
      expect(notices.map((q) => [q.params?.[3], q.params?.[1]])).toEqual([
        ['job.approver_added', 'mgr-1'],
      ]);
    });

    it('runs under the exclusive tenant lock and writes a guarded UPDATE (state re-checked in the WHERE)', async () => {
      const { service, queries } = buildSetActive({
        memberRow: membershipRow(),
      });

      await service.setActive(companyAdmin, 'member-1', false);

      // First statement: the exclusive tenant lock (same lock space as the
      // role-change/remove functions), (tenant, true) = exclusive.
      expect(queries[0].sql).toContain('attendance_lock_tenant');
      expect(queries[0].params?.[0]).toBe('tenant-A');
      expect(queries[0].sql).toContain(', true');
      // The UPDATE carries the from-state as a guard: two racers cannot both win.
      const update = queries.find((q) =>
        q.sql.includes('update public.memberships'),
      );
      expect(update?.sql).toContain('status = $4');
      expect(update?.params).toEqual([
        'deactivated',
        'member-1',
        'tenant-A',
        'active',
      ]);
    });

    it('deactivates and answers the parked state; the audit names member.deactivated with the employee code', async () => {
      const { service, rpc } = buildSetActive({ memberRow: membershipRow() });

      await expect(
        service.setActive(companyAdmin, 'member-1', false),
      ).resolves.toEqual({
        userId: 'member-1',
        status: 'deactivated',
        employeeCode: 'EMP-001',
      });

      expect(rpc).toHaveBeenCalledWith(
        'write_audit_row',
        expect.objectContaining({
          p_action: 'member.deactivated',
          p_target_user: 'member-1',
          p_details: { employee_code: 'EMP-001' },
        }),
      );
    });

    it('reinstates a deactivated member back to active, and the audit names member.reinstated', async () => {
      const { service, rpc } = buildSetActive({
        memberRow: membershipRow({ status: 'deactivated' }),
      });

      await expect(
        service.setActive(companyAdmin, 'member-1', true),
      ).resolves.toEqual({
        userId: 'member-1',
        status: 'active',
        employeeCode: 'EMP-001',
      });

      expect(rpc).toHaveBeenCalledWith(
        'write_audit_row',
        expect.objectContaining({ p_action: 'member.reinstated' }),
      );
    });

    it('a guarded UPDATE that lost the row (race backstop) answers 409 MEMBERSHIP_STATE', async () => {
      const { service } = buildSetActive({
        memberRow: membershipRow(),
        updateRowCount: 0,
      });

      const err = await service
        .setActive(companyAdmin, 'member-1', false)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect(bodyOf(err)).toMatchObject({ error_code: 'MEMBERSHIP_STATE' });
    });
  });

  describe('UpdateEmploymentDto — the pipe-level shapes', () => {
    const validateBody = async (body: Record<string, unknown>) => {
      const dto = plainToInstance(UpdateEmploymentDto, body);
      return validate(dto, { whitelist: true });
    };

    it('takes the full Form V save, and a null as the clear verb', async () => {
      const errors = await validateBody({
        ...fullFormV,
      });
      expect(errors).toHaveLength(0);
      expect(await validateBody({ pan: null, joinDate: null })).toHaveLength(0);
    });

    it('rejects a malformed PAN in plain English, never echoing the value', async () => {
      const errors = await validateBody({ pan: '12bcd345g' });
      expect(errors).toHaveLength(1);
      const message = Object.values(
        errors[0].constraints as Record<string, string>,
      )[0];
      expect(message).toContain('pan');
      expect(message).not.toContain('12bcd345g');
    });

    it('rejects a malformed IFSC', async () => {
      const errors = await validateBody({ ifscCode: 'HDFC12XY34' });
      expect(errors).toHaveLength(1);
      expect(JSON.stringify(errors[0].constraints)).toContain('ifscCode');
    });

    it('rejects a badly shaped date but passes a real one for the service to calendar-check', async () => {
      expect(await validateBody({ joinDate: '01/09/2026' })).toHaveLength(1);
      expect(await validateBody({ joinDate: '2026-02-30' })).toHaveLength(0);
    });

    it('trims text before validation, so a padded PAN still passes the shape', async () => {
      expect(await validateBody({ pan: '  ABCPE1234F  ' })).toHaveLength(0);
    });
  });
});
