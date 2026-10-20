/**
 * change_member_role (migrations 20261020000002 + 5) — real DEV database suite.
 * Each test builds its own throwaway company.
 *
 * Requires a real Supabase project (skipped when SUPABASE_URL is a stub).
 */
import {
  FORBIDDEN,
  IS_REAL_DB,
  LAST_ADMIN,
  NOT_FOUND,
  POINTS_AT_LIVE,
  VALIDATION,
  auditFor,
  call,
  membershipIn,
  mid,
  randomPhone,
  refusal,
  seedPlatformAdmin,
  setUserFlag,
} from '../helpers/member-functions-fixture';
import {
  liveAdminCount,
  makeCompany,
  teardownSuite,
} from '../helpers/member-functions-company';
import { serviceRoleClient } from '../helpers/rls-seed';

const PA = mid('e002', 1);

describe('change_member_role (real DB)', () => {
  const maybeIt = IS_REAL_DB && !POINTS_AT_LIVE ? it : it.skip;
  const service = IS_REAL_DB ? serviceRoleClient() : (null as never);

  const change = (
    caller: string,
    tenant: string,
    member: string,
    role: unknown,
  ) =>
    call<{ member_id: string; old_role: string; new_role: string }[]>(
      service,
      'change_member_role',
      {
        p_caller: caller,
        p_tenant_id: tenant,
        p_member_user_id: member,
        p_new_role: role,
      },
    );
  const roleOf = async (user: string, tenant: string) =>
    (await membershipIn(service, user, tenant))?.role;

  beforeAll(async () => {
    if (!IS_REAL_DB) return;
    expect(POINTS_AT_LIVE).toBe(false);
    await teardownSuite(service);
    await seedPlatformAdmin(service, PA, randomPhone());
  }, 120000);
  afterAll(async () => {
    if (!IS_REAL_DB) return;
    await teardownSuite(service, [], [PA]);
  }, 120000);

  maybeIt(
    'success: role changes, nothing else does, exactly one audit row with old and new role',
    async () => {
      const c = await makeCompany(service, 'role ok', {
        admin: { role: 'company_admin' },
        emp: { role: 'employee' },
      });
      const before = await membershipIn(service, c.id.emp, c.tenantId);
      const r = await change(c.id.admin, c.tenantId, c.id.emp, 'viewer');
      expect(r.error).toBeNull();
      expect(r.data).toEqual([
        { member_id: before?.id, old_role: 'employee', new_role: 'viewer' },
      ]);
      const after = await membershipIn(service, c.id.emp, c.tenantId);
      expect(after).toEqual({ ...before, role: 'viewer' });
      expect(await auditFor(service, c.id.emp)).toEqual([
        {
          actor_user_id: c.id.admin,
          actor_is_platform_admin: false,
          tenant_id: c.tenantId,
          action: 'member.role_change',
          target_user_id: c.id.emp,
          details: { old_role: 'employee', new_role: 'viewer' },
        },
      ]);
    },
  );

  maybeIt(
    'promotion works, and an invited (not yet active) member can be changed too',
    async () => {
      const c = await makeCompany(service, 'role promote', {
        admin: { role: 'company_admin' },
        emp: { role: 'employee' },
        inv: { role: 'viewer', status: 'invited' },
      });
      expect(
        (await change(c.id.admin, c.tenantId, c.id.emp, 'company_admin')).error,
      ).toBeNull();
      expect(await roleOf(c.id.emp, c.tenantId)).toBe('company_admin');
      expect(
        (await change(c.id.admin, c.tenantId, c.id.inv, 'employee')).error,
      ).toBeNull();
      const m = await membershipIn(service, c.id.inv, c.tenantId);
      expect(m).toMatchObject({ role: 'employee', status: 'invited' });
    },
  );

  maybeIt(
    'same-role change succeeds but writes NO audit row and changes nothing',
    async () => {
      const c = await makeCompany(service, 'role same', {
        admin: { role: 'company_admin' },
        emp: { role: 'employee' },
      });
      const r = await change(c.id.admin, c.tenantId, c.id.emp, 'employee');
      expect(r.error).toBeNull();
      expect(r.data?.[0]).toMatchObject({
        old_role: 'employee',
        new_role: 'employee',
      });
      expect(await auditFor(service, c.id.emp)).toEqual([]);
      expect(await roleOf(c.id.emp, c.tenantId)).toBe('employee');
    },
  );

  maybeIt(
    'a role outside company_admin / employee / viewer is VALIDATION_ERROR',
    async () => {
      const c = await makeCompany(service, 'role bad', {
        admin: { role: 'company_admin' },
        emp: { role: 'employee' },
      });
      for (const role of ['platform_admin', 'owner', '', 'Viewer', null]) {
        const r = await change(c.id.admin, c.tenantId, c.id.emp, role);
        expect({ role, ...refusal(r) }).toEqual({ role, ...VALIDATION });
      }
      expect(await roleOf(c.id.emp, c.tenantId)).toBe('employee');
      expect(await auditFor(service, c.id.emp)).toEqual([]);
    },
  );

  maybeIt(
    'an admin cannot change their OWN role, even with other admins around',
    async () => {
      const c = await makeCompany(service, 'role self', {
        a1: { role: 'company_admin' },
        a2: { role: 'company_admin' },
      });
      const r = await change(c.id.a1, c.tenantId, c.id.a1, 'employee');
      expect(refusal(r)).toEqual(FORBIDDEN);
      expect(await roleOf(c.id.a1, c.tenantId)).toBe('company_admin');
      expect(await auditFor(service, c.id.a1)).toEqual([]);
    },
  );

  maybeIt('LAST_ADMIN: the only active admin cannot be demoted', async () => {
    const c = await makeCompany(service, 'role last', {
      admin: { role: 'company_admin' },
      emp: { role: 'employee' },
    });
    for (const role of ['employee', 'viewer']) {
      const r = await change(PA, c.tenantId, c.id.admin, role);
      expect({ role, ...refusal(r) }).toEqual({ role, ...LAST_ADMIN });
    }
    expect(await roleOf(c.id.admin, c.tenantId)).toBe('company_admin');
    expect(await liveAdminCount(service, c.tenantId)).toBe(1);
    expect(await auditFor(service, c.id.admin)).toEqual([]);
  });

  maybeIt(
    'LAST_ADMIN also when the only OTHER admin is disabled, or only invited, or removed',
    async () => {
      const c = await makeCompany(service, 'role last2', {
        admin: { role: 'company_admin' },
        disabledAdmin: { role: 'company_admin', disabled: true },
        invitedAdmin: { role: 'company_admin', status: 'invited' },
        removedAdmin: { role: 'company_admin', status: 'removed' },
      });
      const r = await change(PA, c.tenantId, c.id.admin, 'employee');
      expect(refusal(r)).toEqual(LAST_ADMIN);
      expect(await roleOf(c.id.admin, c.tenantId)).toBe('company_admin');
      // Once the disabled admin is enabled again, the demotion is allowed.
      await setUserFlag(service, c.id.disabledAdmin, { disabled: false });
      expect(
        (await change(PA, c.tenantId, c.id.admin, 'employee')).error,
      ).toBeNull();
      expect(await liveAdminCount(service, c.tenantId)).toBe(1);
    },
  );

  maybeIt(
    'demoting an admin who is NOT the last one works; an invited admin never trips LAST_ADMIN',
    async () => {
      const c = await makeCompany(service, 'role notlast', {
        a1: { role: 'company_admin' },
        a2: { role: 'company_admin' },
        invitedAdmin: { role: 'company_admin', status: 'invited' },
      });
      expect(
        (await change(c.id.a1, c.tenantId, c.id.a2, 'viewer')).error,
      ).toBeNull();
      // a1 is now the only live admin, but the invited admin is not "active":
      expect(
        (await change(c.id.a1, c.tenantId, c.id.invitedAdmin, 'employee'))
          .error,
      ).toBeNull();
      expect(await liveAdminCount(service, c.tenantId)).toBe(1);
    },
  );

  maybeIt(
    'unknown member, removed member, and a member of ANOTHER company are RESOURCE_NOT_FOUND',
    async () => {
      const c = await makeCompany(service, 'role nf', {
        admin: { role: 'company_admin' },
        gone: { role: 'employee', status: 'removed' },
      });
      const other = await makeCompany(service, 'role nf other', {
        admin: { role: 'company_admin' },
        emp: { role: 'employee' },
      });
      for (const target of [mid('e002', 99), c.id.gone, other.id.emp]) {
        const r = await change(c.id.admin, c.tenantId, target, 'viewer');
        expect({ target, ...refusal(r) }).toEqual({ target, ...NOT_FOUND });
      }
      expect(await roleOf(other.id.emp, other.tenantId)).toBe('employee');
      expect(await roleOf(c.id.gone, c.tenantId)).toBe('employee');
    },
  );

  maybeIt(
    'who may change roles: employee, viewer, disabled admin, removed admin, other-company admin, unknown caller are FORBIDDEN',
    async () => {
      const c = await makeCompany(service, 'role callers', {
        admin: { role: 'company_admin' },
        emp: { role: 'employee' },
        viewer: { role: 'viewer' },
        disabledAdmin: { role: 'company_admin', disabled: true },
        removedAdmin: { role: 'company_admin', status: 'removed' },
        target: { role: 'employee' },
      });
      const other = await makeCompany(service, 'role callers other', {
        admin: { role: 'company_admin' },
      });
      const callers = [
        c.id.emp,
        c.id.viewer,
        c.id.disabledAdmin,
        c.id.removedAdmin,
        other.id.admin,
        mid('e002', 98),
      ];
      for (const caller of callers) {
        const r = await change(caller, c.tenantId, c.id.target, 'viewer');
        expect({ caller, ...refusal(r) }).toEqual({ caller, ...FORBIDDEN });
      }
      expect(await roleOf(c.id.target, c.tenantId)).toBe('employee');
      expect(await auditFor(service, c.id.target)).toEqual([]);
    },
  );

  maybeIt(
    'platform admin may change any company; audit says so; unknown company is RESOURCE_NOT_FOUND; a disabled platform admin is FORBIDDEN',
    async () => {
      const c = await makeCompany(service, 'role pa', {
        admin: { role: 'company_admin' },
        emp: { role: 'employee' },
      });
      expect(
        (await change(PA, c.tenantId, c.id.emp, 'viewer')).error,
      ).toBeNull();
      const [row] = await auditFor(service, c.id.emp);
      expect(row).toMatchObject({
        actor_user_id: PA,
        actor_is_platform_admin: true,
      });
      expect(
        refusal(await change(PA, mid('e002', 97), c.id.emp, 'viewer')),
      ).toEqual(NOT_FOUND);
      await setUserFlag(service, PA, { disabled: true });
      try {
        const r = await change(PA, c.tenantId, c.id.emp, 'employee');
        expect(refusal(r)).toEqual(FORBIDDEN);
      } finally {
        await setUserFlag(service, PA, { disabled: false });
      }
      expect(await roleOf(c.id.emp, c.tenantId)).toBe('viewer');
    },
  );
});
