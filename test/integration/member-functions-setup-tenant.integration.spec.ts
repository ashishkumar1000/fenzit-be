/**
 * setup_tenant_for_owner (migration 20261020000003) — real DEV database
 * behaviour suite. First call makes the company, a repeat call only updates
 * its profile; people who belong elsewhere, disabled people and platform
 * admins are refused.
 *
 * Requires a real Supabase project (skipped when SUPABASE_URL is a stub).
 */
import {
  DUPLICATE,
  FORBIDDEN,
  IS_REAL_DB,
  NOT_FOUND,
  POINTS_AT_LIVE,
  call,
  membershipsOf,
  mid,
  randomPhone,
  refusal,
  seedPlatformAdmin,
} from '../helpers/member-functions-fixture';
import {
  makeCompany,
  teardownSuite,
} from '../helpers/member-functions-company';
import { serviceRoleClient } from '../helpers/rls-seed';

const PA = mid('e005', 1);

interface TenantOut {
  id: string;
  created_by: string;
  company_name: string;
  gstin: string | null;
  address: string | null;
  state_code: string;
  upi_vpa: string | null;
  inserted: boolean;
}

describe('setup_tenant_for_owner (real DB)', () => {
  const maybeIt = IS_REAL_DB && !POINTS_AT_LIVE ? it : it.skip;
  const service = IS_REAL_DB ? serviceRoleClient() : (null as never);

  const setup = (user: string, name = 'MFQA Setup Co', extra = {}) =>
    call<TenantOut[]>(service, 'setup_tenant_for_owner', {
      p_user_id: user,
      p_company_name: name,
      p_gstin: null,
      p_address: null,
      p_state_code: 'KA',
      p_upi_vpa: null,
      ...extra,
    });
  const tenantsBy = async (user: string) => {
    const { data } = await service
      .from('tenants')
      .select('id, company_name, gstin, address, state_code, upi_vpa')
      .eq('created_by', user);
    return data as Record<string, unknown>[];
  };

  beforeAll(async () => {
    if (!IS_REAL_DB) return;
    expect(POINTS_AT_LIVE).toBe(false);
    await teardownSuite(service, [], [PA]);
    await seedPlatformAdmin(service, PA, randomPhone());
  }, 120000);
  afterAll(async () => {
    if (!IS_REAL_DB) return;
    await teardownSuite(service, [], [PA]);
  }, 120000);

  /** A person with an identity and no membership at all. */
  const newOwner = async (flags: Record<string, boolean> = {}) => {
    const c = await makeCompany(service, 'setup person', { p: { role: null } });
    if (Object.keys(flags).length)
      await service.from('users').update(flags).eq('id', c.id.p);
    // makeCompany made a tenant for the placeholder; drop it so only the person remains.
    await service.from('tenants').delete().eq('id', c.tenantId);
    return c.id.p;
  };

  maybeIt(
    'first call creates the company and an ACTIVE company_admin membership with an EMP- code',
    async () => {
      const u = await newOwner();
      const r = await setup(u, 'MFQA Setup One');
      expect(r.error).toBeNull();
      const t = (r.data as TenantOut[])[0];
      expect(t).toMatchObject({
        created_by: u,
        company_name: 'MFQA Setup One',
        state_code: 'KA',
        inserted: true,
      });
      const rows = await membershipsOf(service, u);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        tenant_id: t.id,
        role: 'company_admin',
        status: 'active',
      });
      expect(rows[0].employee_code).toMatch(/^EMP-\d{3,}$/);
    },
  );

  maybeIt(
    'second call by the same admin updates the profile: same company, same membership, inserted=false',
    async () => {
      const u = await newOwner();
      const first = (await setup(u, 'MFQA Before')).data as TenantOut[];
      const codeBefore = (await membershipsOf(service, u))[0].employee_code;
      const second = await setup(u, 'MFQA After', {
        p_gstin: '29ABCDE1234F1Z5',
        p_address: '1 Test Road',
        p_state_code: 'MH',
        p_upi_vpa: 'mfqa@upi',
      });
      expect(second.error).toBeNull();
      const t = (second.data as TenantOut[])[0];
      expect(t).toMatchObject({
        id: first[0].id,
        inserted: false,
        company_name: 'MFQA After',
        gstin: '29ABCDE1234F1Z5',
        address: '1 Test Road',
        state_code: 'MH',
        upi_vpa: 'mfqa@upi',
      });
      expect(await tenantsBy(u)).toHaveLength(1);
      const rows = await membershipsOf(service, u);
      expect(rows).toHaveLength(1);
      expect(rows[0].employee_code).toBe(codeBefore);
    },
  );

  maybeIt(
    'people who belong to a company as employee, viewer or invited admin are refused with DUPLICATE_RESOURCE and no company is created',
    async () => {
      const c = await makeCompany(service, 'setup dup', {
        admin: { role: 'company_admin' },
        emp: { role: 'employee' },
        viewer: { role: 'viewer' },
        invitedAdmin: { role: 'company_admin', status: 'invited' },
      });
      for (const who of ['emp', 'viewer', 'invitedAdmin']) {
        const r = await setup(c.id[who]);
        expect({ who, ...refusal(r) }).toEqual({ who, ...DUPLICATE });
        expect(await tenantsBy(c.id[who])).toEqual([]);
        expect(await membershipsOf(service, c.id[who])).toHaveLength(1);
      }
    },
  );

  maybeIt(
    'an active admin of another company edits THAT company; no second company appears',
    async () => {
      const c = await makeCompany(service, 'setup other admin', {
        admin: { role: 'company_admin' },
      });
      const r = await setup(c.id.admin, 'MFQA Renamed');
      expect(r.error).toBeNull();
      expect((r.data as TenantOut[])[0]).toMatchObject({
        id: c.tenantId,
        inserted: false,
      });
      expect(await membershipsOf(service, c.id.admin)).toHaveLength(1);
    },
  );

  maybeIt(
    'a disabled user and a platform admin are FORBIDDEN; an unknown user is RESOURCE_NOT_FOUND; nothing is created',
    async () => {
      const disabled = await newOwner({ disabled: true });
      expect(refusal(await setup(disabled))).toEqual(FORBIDDEN);
      expect(refusal(await setup(PA))).toEqual(FORBIDDEN);
      expect(refusal(await setup(mid('e005', 99)))).toEqual(NOT_FOUND);
      for (const u of [disabled, PA]) {
        expect(await tenantsBy(u)).toEqual([]);
        expect(await membershipsOf(service, u)).toEqual([]);
      }
    },
  );

  maybeIt(
    'a person REMOVED from a company may start a new one; the old removed row is kept',
    async () => {
      const c = await makeCompany(service, 'setup removed', {
        admin: { role: 'company_admin' },
        gone: { role: 'employee', status: 'removed' },
      });
      const r = await setup(c.id.gone, 'MFQA Fresh Start');
      expect(r.error).toBeNull();
      expect((r.data as TenantOut[])[0].inserted).toBe(true);
      const rows = await membershipsOf(service, c.id.gone);
      expect(rows.map((m) => `${m.status}/${m.role}`).sort()).toEqual([
        'active/company_admin',
        'removed/employee',
      ]);
    },
  );

  maybeIt(
    'two simultaneous first calls by the same person create exactly one company',
    async () => {
      const u = await newOwner();
      const [a, b] = await Promise.all([
        setup(u, 'MFQA Race'),
        setup(u, 'MFQA Race'),
      ]);
      expect(a.error).toBeNull();
      expect(b.error).toBeNull();
      const inserted = [a, b].map((r) => (r.data as TenantOut[])[0].inserted);
      expect(inserted.sort()).toEqual([false, true]);
      expect(await tenantsBy(u)).toHaveLength(1);
      expect(await membershipsOf(service, u)).toHaveLength(1);
    },
    60000,
  );
});
