/**
 * remove_member (migrations 20261020000002 + 20261020000005) — real DEV
 * database behaviour suite. Each test builds its own throwaway company.
 *
 * Requires a real Supabase project (skipped when SUPABASE_URL is a stub).
 */
import {
  FORBIDDEN,
  IS_REAL_DB,
  LAST_ADMIN,
  NOT_FOUND,
  POINTS_AT_LIVE,
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
import {
  DUPLICATE as INVITE_DUPLICATE,
  createInviteService,
  serviceInvite,
} from '../helpers/invite-service-world';
import { Role } from '../../src/common/enums/role.enum';

/** The invite envelope's refusal reader (the remove() RPC calls below keep
 *  using the fixture's `refusal`). */
const inviteRefusal = (r: {
  data: unknown;
  error: { status: number; error_code: string } | null;
}) => {
  expect(r.data).toBeNull();
  return r.error;
};

const PA = mid('e003', 1);

describe('remove_member (real DB)', () => {
  const maybeIt = IS_REAL_DB && !POINTS_AT_LIVE ? it : it.skip;
  const service = IS_REAL_DB ? serviceRoleClient() : (null as never);

  const remove = (caller: string, tenant: string, member: string) =>
    call<{ member_id: string; old_role: string }[]>(service, 'remove_member', {
      p_caller: caller,
      p_tenant_id: tenant,
      p_member_user_id: member,
    });
  const statusOf = async (user: string, tenant: string) =>
    (await membershipIn(service, user, tenant))?.status;

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
    'success: status becomes removed, the row and employee code are kept, one audit row with old role and status',
    async () => {
      const c = await makeCompany(service, 'rm ok', {
        admin: { role: 'company_admin' },
        emp: { role: 'employee' },
        inv: { role: 'viewer', status: 'invited' },
      });
      const before = await membershipIn(service, c.id.emp, c.tenantId);
      const r = await remove(c.id.admin, c.tenantId, c.id.emp);
      expect(r.error).toBeNull();
      expect(r.data).toEqual([{ member_id: before?.id, old_role: 'employee' }]);
      expect(await membershipIn(service, c.id.emp, c.tenantId)).toEqual({
        ...before,
        status: 'removed',
      });
      expect(await auditFor(service, c.id.emp)).toEqual([
        {
          actor_user_id: c.id.admin,
          actor_is_platform_admin: false,
          tenant_id: c.tenantId,
          action: 'member.remove',
          target_user_id: c.id.emp,
          details: { old_role: 'employee', old_status: 'active' },
        },
      ]);
      // An invited person can be withdrawn too.
      expect((await remove(c.id.admin, c.tenantId, c.id.inv)).error).toBeNull();
      const [row] = await auditFor(service, c.id.inv);
      expect(row.details).toEqual({
        old_role: 'viewer',
        old_status: 'invited',
      });
    },
    30000,
  );

  maybeIt(
    'an admin cannot remove THEMSELVES, even with other admins around',
    async () => {
      const c = await makeCompany(service, 'rm self', {
        a1: { role: 'company_admin' },
        a2: { role: 'company_admin' },
      });
      expect(refusal(await remove(c.id.a1, c.tenantId, c.id.a1))).toEqual(
        FORBIDDEN,
      );
      expect(await statusOf(c.id.a1, c.tenantId)).toBe('active');
      expect(await auditFor(service, c.id.a1)).toEqual([]);
    },
    30000,
  );

  maybeIt(
    'LAST_ADMIN: the only active admin cannot be removed, also when the only other admin is disabled, invited or removed',
    async () => {
      const solo = await makeCompany(service, 'rm last', {
        admin: { role: 'company_admin' },
        emp: { role: 'employee' },
      });
      expect(refusal(await remove(PA, solo.tenantId, solo.id.admin))).toEqual(
        LAST_ADMIN,
      );
      const c = await makeCompany(service, 'rm last2', {
        admin: { role: 'company_admin' },
        disabledAdmin: { role: 'company_admin', disabled: true },
        invitedAdmin: { role: 'company_admin', status: 'invited' },
        removedAdmin: { role: 'company_admin', status: 'removed' },
      });
      expect(refusal(await remove(PA, c.tenantId, c.id.admin))).toEqual(
        LAST_ADMIN,
      );
      expect(await statusOf(c.id.admin, c.tenantId)).toBe('active');
      expect(await auditFor(service, c.id.admin)).toEqual([]);
      // The disabled admin is active-but-unusable: removing THEM is fine.
      expect(
        (await remove(PA, c.tenantId, c.id.disabledAdmin)).error,
      ).toBeNull();
      // Re-enabled admin makes the removal of the first one legal.
      const d = await makeCompany(service, 'rm last3', {
        admin: { role: 'company_admin' },
        other: { role: 'company_admin', disabled: true },
      });
      await setUserFlag(service, d.id.other, { disabled: false });
      expect((await remove(PA, d.tenantId, d.id.admin)).error).toBeNull();
      expect(await liveAdminCount(service, d.tenantId)).toBe(1);
    },
    30000,
  );

  maybeIt(
    'unknown, already-removed and other-company members are RESOURCE_NOT_FOUND; a second remove writes no second audit row',
    async () => {
      const c = await makeCompany(service, 'rm nf', {
        admin: { role: 'company_admin' },
        emp: { role: 'employee' },
      });
      const other = await makeCompany(service, 'rm nf other', {
        admin: { role: 'company_admin' },
        emp: { role: 'employee' },
      });
      expect((await remove(c.id.admin, c.tenantId, c.id.emp)).error).toBeNull();
      for (const target of [mid('e003', 99), c.id.emp, other.id.emp]) {
        const r = await remove(c.id.admin, c.tenantId, target);
        expect({ target, ...refusal(r) }).toEqual({ target, ...NOT_FOUND });
      }
      expect(await auditFor(service, c.id.emp, 'member.remove')).toHaveLength(
        1,
      );
      expect(await statusOf(other.id.emp, other.tenantId)).toBe('active');
    },
    30000,
  );

  maybeIt(
    'who may remove: employee, viewer, disabled admin, removed admin, other-company admin, unknown caller are FORBIDDEN',
    async () => {
      const c = await makeCompany(service, 'rm callers', {
        admin: { role: 'company_admin' },
        emp: { role: 'employee' },
        viewer: { role: 'viewer' },
        disabledAdmin: { role: 'company_admin', disabled: true },
        removedAdmin: { role: 'company_admin', status: 'removed' },
        target: { role: 'employee' },
      });
      const other = await makeCompany(service, 'rm callers other', {
        admin: { role: 'company_admin' },
      });
      const callers = [
        c.id.emp,
        c.id.viewer,
        c.id.disabledAdmin,
        c.id.removedAdmin,
        other.id.admin,
        mid('e003', 98),
      ];
      for (const caller of callers) {
        const r = await remove(caller, c.tenantId, c.id.target);
        expect({ caller, ...refusal(r) }).toEqual({ caller, ...FORBIDDEN });
      }
      expect(await statusOf(c.id.target, c.tenantId)).toBe('active');
      expect(await auditFor(service, c.id.target)).toEqual([]);
    },
    30000,
  );

  maybeIt(
    'platform admin may remove from any company (audit says so); unknown company is RESOURCE_NOT_FOUND',
    async () => {
      const c = await makeCompany(service, 'rm pa', {
        admin: { role: 'company_admin' },
        emp: { role: 'employee' },
      });
      expect((await remove(PA, c.tenantId, c.id.emp)).error).toBeNull();
      const [row] = await auditFor(service, c.id.emp);
      expect(row).toMatchObject({
        actor_user_id: PA,
        actor_is_platform_admin: true,
      });
      expect(refusal(await remove(PA, mid('e003', 97), c.id.emp))).toEqual(
        NOT_FOUND,
      );
    },
    30000,
  );

  maybeIt(
    'a removed person is free to be invited by ANOTHER company (the one-live-membership rule is released)',
    async () => {
      const c = await makeCompany(service, 'rm free', {
        admin: { role: 'company_admin' },
        emp: { role: 'employee' },
      });
      const other = await makeCompany(service, 'rm free other', {
        admin: { role: 'company_admin' },
      });
      const { data: u } = await service
        .from('users')
        .select('country_code, phone_number')
        .eq('id', c.id.emp)
        .single();
      const phone = u as { country_code: string; phone_number: string };
      // The invite side runs on the shipped TypeScript path (invite_member is
      // dropped); the audit it writes is cleaned by teardownSuite below.
      const { authService } = await createInviteService();
      const invite = () =>
        serviceInvite(
          authService,
          {
            userId: other.id.admin,
            tenantId: other.tenantId,
            role: Role.COMPANY_ADMIN,
            platformAdmin: false,
            rawJwt: 'probe',
          },
          {
            countryCode: phone.country_code,
            phoneNumber: phone.phone_number,
            name: 'rm free invitee',
          },
        );
      expect(inviteRefusal(await invite())).toEqual(INVITE_DUPLICATE);
      await remove(c.id.admin, c.tenantId, c.id.emp);
      expect((await invite()).error).toBeNull();
    },
    30000,
  );
});
