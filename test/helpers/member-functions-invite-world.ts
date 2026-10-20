/**
 * Shared world for the invite_member suites: two companies, the people every
 * invite test needs, and the `invite` / query helpers. Real DEV database only.
 */

import {
  IS_REAL_DB,
  POINTS_AT_LIVE,
  RpcOut,
  call,
  mid,
  seedPlatformAdmin,
  setUserFlag,
} from './member-functions-fixture';
import { teardownSuite } from './member-functions-company';
import { seedCompany, serviceRoleClient } from './rls-seed';

const B = 'e001';
const P = {
  tenantA: mid(B, 1),
  tenantB: mid(B, 2),
  adminA: mid(B, 11),
  employeeA: mid(B, 12),
  viewerA: mid(B, 13),
  disabledAdminA: mid(B, 14),
  removedAdminA: mid(B, 15),
  adminB: mid(B, 21),
  employeeB: mid(B, 22),
  stranger: mid(B, 31), // identity only, no membership, no name
  disabledStranger: mid(B, 32),
  platformAdmin: mid(B, 41),
  nobody: mid(B, 99), // a uuid that is not a user at all
};
const PEOPLE = [
  P.adminA,
  P.employeeA,
  P.viewerA,
  P.disabledAdminA,
  P.removedAdminA,
  P.adminB,
  P.employeeB,
  P.stranger,
  P.disabledStranger,
  P.platformAdmin,
];
const PHONE = {
  stranger: '9999700031',
  disabledStranger: '9999700032',
  platformAdmin: '9999700041',
};

type InviteRow = {
  member_id: string;
  member_user_id: string;
  member_employee_code: string;
  was_user_created: boolean;
  was_reactivated: boolean;
};

export { B, P, PHONE };
export type { InviteRow };

export function useInviteWorld() {
  const maybeIt = IS_REAL_DB && !POINTS_AT_LIVE ? it : it.skip;
  const service = IS_REAL_DB ? serviceRoleClient() : (null as never);
  let skillId = '';

  const invite = (
    caller: string,
    tenant: string,
    phone: string,
    opts: {
      role?: string;
      name?: string | null;
      cc?: string | null;
      skills?: string[];
    } = {},
  ): Promise<RpcOut<InviteRow[]>> =>
    call<InviteRow[]>(service, 'invite_member', {
      p_caller: caller,
      p_tenant_id: tenant,
      p_country_code: opts.cc === undefined ? '+91' : opts.cc,
      p_phone_number: phone,
      p_name: opts.name === undefined ? 'MF Invitee' : opts.name,
      p_role: opts.role ?? 'employee',
      p_skill_ids: opts.skills ?? [],
    });

  const ok = (r: RpcOut<InviteRow[]>): InviteRow => {
    expect(r.error).toBeNull();
    expect(r.data).toHaveLength(1);
    return (r.data as InviteRow[])[0];
  };

  const usersWithPhone = async (phone: string) => {
    const { data, error } = await service
      .from('users')
      .select('id, name, country_code')
      .eq('phone_number', phone);
    expect(error).toBeNull();
    return data as { id: string; name: string | null; country_code: string }[];
  };

  const inviteAuditCount = async (tenant: string) => {
    const { count } = await service
      .from('audit_log')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', tenant)
      .eq('action', 'member.invite');
    return count ?? 0;
  };

  beforeAll(async () => {
    if (!IS_REAL_DB) return;
    expect(POINTS_AT_LIVE).toBe(false);
    await teardownSuite(service, [P.tenantA, P.tenantB], PEOPLE);
    await seedCompany(service, {
      tenantId: P.tenantA,
      companyName: 'MF Invite Co A',
      createdBy: P.adminA,
      people: [
        { id: P.adminA, phone: '9999700011', role: 'company_admin' },
        { id: P.employeeA, phone: '9999700012', role: 'employee' },
        { id: P.viewerA, phone: '9999700013', role: 'viewer' },
        { id: P.disabledAdminA, phone: '9999700014', role: 'company_admin' },
        {
          id: P.removedAdminA,
          phone: '9999700015',
          role: 'company_admin',
          status: 'removed',
        },
      ],
    });
    await seedCompany(service, {
      tenantId: P.tenantB,
      companyName: 'MF Invite Co B',
      createdBy: P.adminB,
      people: [
        { id: P.adminB, phone: '9999700021', role: 'company_admin' },
        { id: P.employeeB, phone: '9999700022', role: 'employee' },
        { id: P.stranger, phone: PHONE.stranger, role: null },
        { id: P.disabledStranger, phone: PHONE.disabledStranger, role: null },
      ],
    });
    await setUserFlag(service, P.disabledAdminA, { disabled: true });
    await setUserFlag(service, P.disabledStranger, { disabled: true });
    await seedPlatformAdmin(service, P.platformAdmin, PHONE.platformAdmin);
    const { data: skill } = await service
      .from('skills')
      .select('id')
      .eq('is_active', true)
      .limit(1)
      .single();
    skillId = (skill as { id: string }).id;
  }, 120000);

  afterAll(async () => {
    if (!IS_REAL_DB) return;
    await teardownSuite(service, [P.tenantA, P.tenantB], PEOPLE);
  }, 120000);

  return {
    maybeIt,
    service,
    invite,
    ok,
    usersWithPhone,
    inviteAuditCount,
    skillId: () => skillId,
  };
}
