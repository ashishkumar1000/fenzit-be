/**
 * set_user_disabled (migrations 20261020000002) — real DEV database behaviour
 * suite. Only a platform admin may switch a person off or on.
 *
 * Requires a real Supabase project (skipped when SUPABASE_URL is a stub).
 */
import {
  FORBIDDEN,
  IS_REAL_DB,
  NOT_FOUND,
  POINTS_AT_LIVE,
  VALIDATION,
  auditFor,
  call,
  mid,
  randomPhone,
  refusal,
  seedPlatformAdmin,
  setUserFlag,
} from '../helpers/member-functions-fixture';
import {
  makeCompany,
  teardownSuite,
} from '../helpers/member-functions-company';
import { serviceRoleClient } from '../helpers/rls-seed';

const PA = mid('e004', 1);
const PA2 = mid('e004', 2);

describe('set_user_disabled (real DB)', () => {
  const maybeIt = IS_REAL_DB && !POINTS_AT_LIVE ? it : it.skip;
  const service = IS_REAL_DB ? serviceRoleClient() : (null as never);

  const setDisabled = (caller: string, user: string, disabled: unknown) =>
    call<boolean>(service, 'set_user_disabled', {
      p_caller: caller,
      p_user_id: user,
      p_disabled: disabled,
    });
  const isDisabled = async (user: string) => {
    const { data } = await service
      .from('users')
      .select('disabled')
      .eq('id', user)
      .single();
    return (data as { disabled: boolean }).disabled;
  };

  beforeAll(async () => {
    if (!IS_REAL_DB) return;
    expect(POINTS_AT_LIVE).toBe(false);
    await teardownSuite(service, [], [PA, PA2]);
    await seedPlatformAdmin(service, PA, randomPhone());
    await seedPlatformAdmin(service, PA2, randomPhone());
  }, 120000);
  afterAll(async () => {
    if (!IS_REAL_DB) return;
    await teardownSuite(service, [], [PA, PA2]);
  }, 120000);

  maybeIt(
    'platform admin disables and enables: flag flips, one platform-wide audit row per real change',
    async () => {
      const c = await makeCompany(service, 'dis ok', {
        admin: { role: 'company_admin' },
        emp: { role: 'employee' },
      });
      const off = await setDisabled(PA, c.id.emp, true);
      expect(off.error).toBeNull();
      expect(off.data).toBe(true);
      expect(await isDisabled(c.id.emp)).toBe(true);
      expect(await auditFor(service, c.id.emp)).toEqual([
        {
          actor_user_id: PA,
          actor_is_platform_admin: true,
          tenant_id: null,
          action: 'user.disable',
          target_user_id: c.id.emp,
          details: {},
        },
      ]);
      const on = await setDisabled(PA, c.id.emp, false);
      expect(on.data).toBe(false);
      expect(await isDisabled(c.id.emp)).toBe(false);
      expect(
        (await auditFor(service, c.id.emp)).map((a) => a.action).sort(),
      ).toEqual(['user.disable', 'user.enable']);
    },
  );

  maybeIt(
    'idempotent: repeating the same value changes nothing and writes no second audit row',
    async () => {
      const c = await makeCompany(service, 'dis idem', {
        admin: { role: 'company_admin' },
        emp: { role: 'employee' },
      });
      // Enabling a person who was never disabled: nothing happens.
      expect((await setDisabled(PA, c.id.emp, false)).data).toBe(false);
      expect(await auditFor(service, c.id.emp)).toEqual([]);
      for (let i = 0; i < 3; i++) {
        const r = await setDisabled(PA, c.id.emp, true);
        expect(r.error).toBeNull();
        expect(r.data).toBe(true);
      }
      expect(await auditFor(service, c.id.emp, 'user.disable')).toHaveLength(1);
      // Two simultaneous disables: still exactly one audit row.
      await setDisabled(PA, c.id.emp, false);
      await Promise.all([
        setDisabled(PA, c.id.emp, true),
        setDisabled(PA2, c.id.emp, true),
      ]);
      expect(await isDisabled(c.id.emp)).toBe(true);
      expect(await auditFor(service, c.id.emp, 'user.disable')).toHaveLength(2); // 1st disable + this one
    },
    60000,
  );

  maybeIt(
    'only a platform admin: company admin, employee, viewer, a non-member and an unknown caller are FORBIDDEN and nothing changes',
    async () => {
      const c = await makeCompany(service, 'dis who', {
        admin: { role: 'company_admin' },
        emp: { role: 'employee' },
        viewer: { role: 'viewer' },
        stranger: { role: null },
        target: { role: 'employee' },
      });
      for (const caller of [
        c.id.admin,
        c.id.emp,
        c.id.viewer,
        c.id.stranger,
        c.id.target,
        mid('e004', 98),
      ]) {
        const r = await setDisabled(caller, c.id.target, true);
        expect({ caller, ...refusal(r) }).toEqual({ caller, ...FORBIDDEN });
      }
      expect(await isDisabled(c.id.target)).toBe(false);
      expect(await auditFor(service, c.id.target)).toEqual([]);
    },
  );

  maybeIt(
    'a disabled platform admin may not use it; self-disable is refused',
    async () => {
      const c = await makeCompany(service, 'dis pa', {
        admin: { role: 'company_admin' },
      });
      expect(refusal(await setDisabled(PA, PA, true))).toEqual(FORBIDDEN);
      expect(await isDisabled(PA)).toBe(false);
      expect(refusal(await setDisabled(PA, PA, false))).toEqual(FORBIDDEN);
      await setUserFlag(service, PA2, { disabled: true });
      try {
        expect(refusal(await setDisabled(PA2, c.id.admin, true))).toEqual(
          FORBIDDEN,
        );
        expect(await isDisabled(c.id.admin)).toBe(false);
      } finally {
        await setUserFlag(service, PA2, { disabled: false });
      }
      // A platform admin may disable another platform admin.
      expect((await setDisabled(PA, PA2, true)).error).toBeNull();
      expect(await isDisabled(PA2)).toBe(true);
      await setUserFlag(service, PA2, { disabled: false });
    },
  );

  maybeIt(
    'unknown user is RESOURCE_NOT_FOUND; a null or non-boolean flag is refused',
    async () => {
      expect(refusal(await setDisabled(PA, mid('e004', 99), true))).toEqual(
        NOT_FOUND,
      );
      expect(refusal(await setDisabled(PA, mid('e004', 99), null))).toEqual(
        VALIDATION,
      );
      const c = await makeCompany(service, 'dis bad', {
        admin: { role: 'company_admin' },
      });
      const r = await setDisabled(PA, c.id.admin, 'maybe');
      expect(r.error).not.toBeNull();
      expect(await isDisabled(c.id.admin)).toBe(false);
      expect(await auditFor(service, c.id.admin)).toEqual([]);
    },
  );
});
