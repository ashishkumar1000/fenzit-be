/**
 * set_member_job_settings (migration 20261112000001) — real DEV database suite.
 * Each test builds its own throwaway company.
 *
 * Plain English: only the owner of THIS company may set an employee's two job
 * switches. The platform admin flag grants nothing here. The target must be an
 * active employee of that company. Every real change leaves exactly one audit row.
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
  seedPlatformAdmin,
} from '../helpers/member-functions-fixture';
import {
  makeCompany,
  teardownSuite,
} from '../helpers/member-functions-company';
import { serviceRoleClient } from '../helpers/rls-seed';

/** The three columns this story adds, read straight from memberships. */
interface SettingsRow {
  id: string;
  role: string;
  status: string;
  can_create_jobs: boolean;
  job_approval_required: boolean;
}

const PA = mid('e003', 1);
const NOT_AN_EMPLOYEE = { code: 'PT400', hint: 'NOT_AN_EMPLOYEE' };

type Settings = { member_id: string; can_create_jobs: boolean; job_approval_required: boolean }[];

describe('set_member_job_settings (real DB)', () => {
  jest.setTimeout(120000);
  const maybeIt = IS_REAL_DB && !POINTS_AT_LIVE ? it : it.skip;
  const service = IS_REAL_DB ? serviceRoleClient() : (null as never);

  const set = (
    caller: string,
    tenant: string,
    member: string,
    canCreate: unknown,
    approval: unknown,
  ) =>
    call<Settings>(service, 'set_member_job_settings', {
      p_caller: caller,
      p_tenant_id: tenant,
      p_member_user_id: member,
      p_can_create_jobs: canCreate,
      p_job_approval_required: approval,
    });

  const membershipIn = async (user: string, tenant: string) => {
    const { data, error } = await service
      .from('memberships')
      .select('id, role, status, can_create_jobs, job_approval_required')
      .eq('user_id', user)
      .eq('tenant_id', tenant)
      .maybeSingle<SettingsRow>();
    expect(error).toBeNull();
    return data;
  };

  const refusal = (r: { error: { code?: string; hint?: string | null } | null }) => ({
    code: r.error?.code,
    hint: r.error?.hint,
  });

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

  maybeIt('a new employee starts with creation off and approval on', async () => {
    const c = await makeCompany(service, 'js defaults', {
      admin: { role: 'company_admin' },
      emp: { role: 'employee' },
    });
    const m = await membershipIn(c.id.emp, c.tenantId);
    expect(m).toMatchObject({ can_create_jobs: false, job_approval_required: true });
  });

  maybeIt(
    'success: the owner sets both switches, returns them, and writes one audit row',
    async () => {
      const c = await makeCompany(service, 'js ok', {
        admin: { role: 'company_admin' },
        emp: { role: 'employee' },
      });
      const before = await membershipIn(c.id.emp, c.tenantId);
      const r = await set(c.id.admin, c.tenantId, c.id.emp, true, false);
      expect(r.error).toBeNull();
      expect(r.data).toEqual([
        { member_id: before?.id, can_create_jobs: true, job_approval_required: false },
      ]);
      const after = await membershipIn(c.id.emp, c.tenantId);
      expect(after).toMatchObject({
        role: 'employee',
        status: 'active',
        can_create_jobs: true,
        job_approval_required: false,
      });
      expect(await auditFor(service, c.id.emp, 'member.job_settings_change')).toEqual([
        {
          actor_user_id: c.id.admin,
          actor_is_platform_admin: false,
          tenant_id: c.tenantId,
          action: 'member.job_settings_change',
          target_user_id: c.id.emp,
          details: {
            old_can_create_jobs: false,
            new_can_create_jobs: true,
            old_job_approval_required: true,
            new_job_approval_required: false,
          },
        },
      ]);
    },
  );

  maybeIt(
    'a repeat of the same values changes nothing and writes NO second audit row',
    async () => {
      const c = await makeCompany(service, 'js repeat', {
        admin: { role: 'company_admin' },
        emp: { role: 'employee' },
      });
      expect((await set(c.id.admin, c.tenantId, c.id.emp, true, true)).error).toBeNull();
      const again = await set(c.id.admin, c.tenantId, c.id.emp, true, true);
      expect(again.error).toBeNull();
      expect(again.data?.[0]).toMatchObject({ can_create_jobs: true, job_approval_required: true });
      expect(await auditFor(service, c.id.emp, 'member.job_settings_change')).toHaveLength(1);
    },
  );

  maybeIt('each switch can be changed on its own, the other stays as it was', async () => {
    const c = await makeCompany(service, 'js single', {
      admin: { role: 'company_admin' },
      emp: { role: 'employee' },
    });
    expect((await set(c.id.admin, c.tenantId, c.id.emp, true, true)).error).toBeNull();
    expect((await set(c.id.admin, c.tenantId, c.id.emp, true, false)).error).toBeNull();
    expect(await membershipIn(c.id.emp, c.tenantId)).toMatchObject({
      can_create_jobs: true,
      job_approval_required: false,
    });
  });

  maybeIt('an employee cannot set their own or anyone else\'s switches', async () => {
    const c = await makeCompany(service, 'js emp caller', {
      admin: { role: 'company_admin' },
      emp: { role: 'employee' },
      other: { role: 'employee' },
    });
    expect(refusal(await set(c.id.emp, c.tenantId, c.id.other, true, false))).toEqual(FORBIDDEN);
    expect(refusal(await set(c.id.emp, c.tenantId, c.id.emp, true, false))).toEqual(FORBIDDEN);
    expect(await membershipIn(c.id.other, c.tenantId)).toMatchObject({
      can_create_jobs: false,
      job_approval_required: true,
    });
  });

  maybeIt('a viewer cannot set the switches', async () => {
    const c = await makeCompany(service, 'js viewer caller', {
      admin: { role: 'company_admin' },
      view: { role: 'viewer' },
      emp: { role: 'employee' },
    });
    expect(refusal(await set(c.id.view, c.tenantId, c.id.emp, true, false))).toEqual(FORBIDDEN);
  });

  maybeIt('the platform admin flag grants no job-settings power in a company', async () => {
    const c = await makeCompany(service, 'js platform admin', {
      admin: { role: 'company_admin' },
      emp: { role: 'employee' },
    });
    expect(refusal(await set(PA, c.tenantId, c.id.emp, true, false))).toEqual(FORBIDDEN);
    expect(await membershipIn(c.id.emp, c.tenantId)).toMatchObject({
      can_create_jobs: false,
    });
  });

  maybeIt('an owner of another company cannot set this company\'s employee', async () => {
    const a = await makeCompany(service, 'js cross A', {
      admin: { role: 'company_admin' },
    });
    const b = await makeCompany(service, 'js cross B', {
      admin: { role: 'company_admin' },
      emp: { role: 'employee' },
    });
    // Caller is owner of A, names company B as the tenant: refused.
    expect(refusal(await set(a.id.admin, b.tenantId, b.id.emp, true, false))).toEqual(FORBIDDEN);
    // Caller is owner of A, names A, but the employee belongs to B: not found.
    expect(refusal(await set(a.id.admin, a.tenantId, b.id.emp, true, false))).toEqual(NOT_FOUND);
    expect(await membershipIn(b.id.emp, b.tenantId)).toMatchObject({
      can_create_jobs: false,
    });
  });

  maybeIt('a disabled owner cannot set the switches', async () => {
    const c = await makeCompany(service, 'js disabled owner', {
      admin: { role: 'company_admin', disabled: true },
      emp: { role: 'employee' },
    });
    expect(refusal(await set(c.id.admin, c.tenantId, c.id.emp, true, false))).toEqual(FORBIDDEN);
  });

  maybeIt('the target must be an employee: owners and viewers are refused', async () => {
    const c = await makeCompany(service, 'js target role', {
      admin: { role: 'company_admin' },
      other_admin: { role: 'company_admin' },
      view: { role: 'viewer' },
    });
    expect(refusal(await set(c.id.admin, c.tenantId, c.id.other_admin, true, false))).toEqual(NOT_AN_EMPLOYEE);
    expect(refusal(await set(c.id.admin, c.tenantId, c.id.view, true, false))).toEqual(NOT_AN_EMPLOYEE);
    expect(await auditFor(service, c.id.view, 'member.job_settings_change')).toEqual([]);
  });

  maybeIt('an invited, removed or unknown person is not found', async () => {
    const c = await makeCompany(service, 'js not active', {
      admin: { role: 'company_admin' },
      inv: { role: 'employee', status: 'invited' },
      gone: { role: 'employee', status: 'removed' },
    });
    expect(refusal(await set(c.id.admin, c.tenantId, c.id.inv, true, false))).toEqual(NOT_FOUND);
    expect(refusal(await set(c.id.admin, c.tenantId, c.id.gone, true, false))).toEqual(NOT_FOUND);
    expect(refusal(await set(c.id.admin, c.tenantId, mid('e003', 99), true, false))).toEqual(NOT_FOUND);
  });

  maybeIt('a null switch value is refused, and nothing changes', async () => {
    const c = await makeCompany(service, 'js null', {
      admin: { role: 'company_admin' },
      emp: { role: 'employee' },
    });
    expect(refusal(await set(c.id.admin, c.tenantId, c.id.emp, null, false))).toEqual(VALIDATION);
    expect(refusal(await set(c.id.admin, c.tenantId, c.id.emp, true, null))).toEqual(VALIDATION);
    expect(await membershipIn(c.id.emp, c.tenantId)).toMatchObject({
      can_create_jobs: false,
      job_approval_required: true,
    });
  });
});
