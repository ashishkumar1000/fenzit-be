/**
 * Concurrency of change_member_role / remove_member (migration
 * 20261020000005): the company lock must stop two admins from removing or
 * demoting each other at the same moment, so a company always keeps at least
 * one active, enabled admin.
 *
 * Requires a real Supabase project (skipped when SUPABASE_URL is a stub).
 */
import {
  IS_REAL_DB,
  NOT_FOUND,
  POINTS_AT_LIVE,
  auditFor,
  call,
  membershipIn,
  refusal,
} from '../helpers/member-functions-fixture';
import {
  liveAdminCount,
  makeCompany,
  teardownSuite,
} from '../helpers/member-functions-company';
import { serviceRoleClient } from '../helpers/rls-seed';

describe('member function races (real DB)', () => {
  const maybeIt = IS_REAL_DB && !POINTS_AT_LIVE ? it : it.skip;
  const service = IS_REAL_DB ? serviceRoleClient() : (null as never);

  const change = (
    caller: string,
    tenant: string,
    member: string,
    role: string,
  ) =>
    call(service, 'change_member_role', {
      p_caller: caller,
      p_tenant_id: tenant,
      p_member_user_id: member,
      p_new_role: role,
    });
  const remove = (caller: string, tenant: string, member: string) =>
    call(service, 'remove_member', {
      p_caller: caller,
      p_tenant_id: tenant,
      p_member_user_id: member,
    });
  const roleOf = async (user: string, tenant: string) =>
    (await membershipIn(service, user, tenant))?.role;

  beforeAll(async () => {
    if (!IS_REAL_DB) return;
    expect(POINTS_AT_LIVE).toBe(false);
    await teardownSuite(service);
  }, 120000);
  afterAll(async () => {
    if (!IS_REAL_DB) return;
    await teardownSuite(service);
  }, 120000);

  maybeIt(
    'two admins demoting EACH OTHER at the same moment: not both succeed, the company keeps an admin',
    async () => {
      for (let round = 0; round < 4; round++) {
        const c = await makeCompany(service, `role race ${round}`, {
          a1: { role: 'company_admin' },
          a2: { role: 'company_admin' },
        });
        const [x, y] = await Promise.all([
          change(c.id.a1, c.tenantId, c.id.a2, 'employee'),
          change(c.id.a2, c.tenantId, c.id.a1, 'employee'),
        ]);
        const wins = [x, y].filter((r) => r.error === null);
        expect({ round, wins: wins.length }).toEqual({ round, wins: 1 });
        const lost = [x, y].find((r) => r.error !== null);
        expect(['FORBIDDEN', 'LAST_ADMIN']).toContain(lost?.error?.hint);
        expect(await liveAdminCount(service, c.tenantId)).toBe(1);
        expect(
          await auditFor(service, c.id.a1, 'member.role_change'),
        ).toHaveLength(
          (await roleOf(c.id.a1, c.tenantId)) === 'employee' ? 1 : 0,
        );
      }
    },
    60000,
  );

  maybeIt(
    'three admins demoting each other in a ring: at least one admin always remains',
    async () => {
      for (let round = 0; round < 3; round++) {
        const c = await makeCompany(service, `role ring ${round}`, {
          a1: { role: 'company_admin' },
          a2: { role: 'company_admin' },
          a3: { role: 'company_admin' },
        });
        await Promise.all([
          change(c.id.a1, c.tenantId, c.id.a2, 'viewer'),
          change(c.id.a2, c.tenantId, c.id.a3, 'viewer'),
          change(c.id.a3, c.tenantId, c.id.a1, 'viewer'),
        ]);
        expect(
          await liveAdminCount(service, c.tenantId),
        ).toBeGreaterThanOrEqual(1);
      }
    },
    60000,
  );

  maybeIt(
    'two admins removing EACH OTHER at the same moment: exactly one succeeds, an admin remains',
    async () => {
      for (let round = 0; round < 4; round++) {
        const c = await makeCompany(service, `rm race ${round}`, {
          a1: { role: 'company_admin' },
          a2: { role: 'company_admin' },
        });
        const [x, y] = await Promise.all([
          remove(c.id.a1, c.tenantId, c.id.a2),
          remove(c.id.a2, c.tenantId, c.id.a1),
        ]);
        expect({
          round,
          wins: [x, y].filter((r) => r.error === null).length,
        }).toEqual({ round, wins: 1 });
        const lost = [x, y].find((r) => r.error !== null);
        expect(['FORBIDDEN', 'LAST_ADMIN']).toContain(lost?.error?.hint);
        expect(await liveAdminCount(service, c.tenantId)).toBe(1);
      }
    },
    60000,
  );

  maybeIt(
    'one admin removing while the other demotes: the company never ends with zero admins',
    async () => {
      const c = await makeCompany(service, 'rm mixed', {
        a1: { role: 'company_admin' },
        a2: { role: 'company_admin' },
      });
      await Promise.all([
        remove(c.id.a1, c.tenantId, c.id.a2),
        call(service, 'change_member_role', {
          p_caller: c.id.a2,
          p_tenant_id: c.tenantId,
          p_member_user_id: c.id.a1,
          p_new_role: 'viewer',
        }),
      ]);
      expect(await liveAdminCount(service, c.tenantId)).toBeGreaterThanOrEqual(
        1,
      );
    },
    60000,
  );

  maybeIt(
    'the same member removed twice at once: one success, one RESOURCE_NOT_FOUND, one audit row',
    async () => {
      const c = await makeCompany(service, 'rm double', {
        a1: { role: 'company_admin' },
        a2: { role: 'company_admin' },
        emp: { role: 'employee' },
      });
      const [x, y] = await Promise.all([
        remove(c.id.a1, c.tenantId, c.id.emp),
        remove(c.id.a2, c.tenantId, c.id.emp),
      ]);
      expect([x, y].filter((r) => r.error === null)).toHaveLength(1);
      expect(refusal([x, y].find((r) => r.error !== null) as never)).toEqual(
        NOT_FOUND,
      );
      expect(await auditFor(service, c.id.emp, 'member.remove')).toHaveLength(
        1,
      );
    },
    60000,
  );

  it('(always) suite is wired', () => {
    expect(true).toBe(true);
  });
});
