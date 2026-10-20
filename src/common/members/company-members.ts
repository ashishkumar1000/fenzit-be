import { SupabaseClient } from '@supabase/supabase-js';
import { MembershipRole } from '../enums/role.enum';

/**
 * One person in one company: the membership (role, status, employee code)
 * joined to the identity (name, phone). The single place the backend answers
 * "who is in this company", so every reader filters by company the same way
 * and a removed member is excluded unless the caller asks for history.
 */
export interface CompanyMember {
  userId: string;
  name: string | null;
  countryCode: string;
  phoneNumber: string;
  employeeCode: string;
  role: MembershipRole;
  status: 'invited' | 'active' | 'removed';
  createdAt: string;
  /** Present only when `withSkills` was requested. */
  skills?: Array<{ id: string; name: string }>;
}

export interface CompanyMemberFilter {
  role?: MembershipRole;
  userIds?: string[];
  /** Include `removed` members (history views). Default: false. */
  includeRemoved?: boolean;
  withSkills?: boolean;
}

interface MemberRow {
  user_id: string;
  role: MembershipRole;
  status: CompanyMember['status'];
  employee_code: string;
  created_at: string;
  users: {
    name: string | null;
    country_code: string;
    phone_number: string;
    disabled: boolean;
    user_skills?: Array<{
      skills: { id: string; name: string } | Array<{ id: string; name: string }> | null;
    }> | null;
  } | null;
}

// memberships has two keys to users (user_id, invited_by): name the one we want.
const USER_EMBED = 'users!memberships_user_id_fkey';

export async function listCompanyMembers(
  admin: SupabaseClient,
  tenantId: string,
  filter: CompanyMemberFilter = {},
): Promise<CompanyMember[]> {
  if (filter.userIds && filter.userIds.length === 0) {
    return [];
  }
  const userCols = filter.withSkills
    ? 'name, country_code, phone_number, disabled, user_skills(skills(id, name))'
    : 'name, country_code, phone_number, disabled';

  let qb = admin
    .from('memberships')
    .select(
      `user_id, role, status, employee_code, created_at, ${USER_EMBED}(${userCols})`,
    )
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: true });

  if (filter.role) qb = qb.eq('role', filter.role);
  if (filter.userIds) qb = qb.in('user_id', filter.userIds);
  if (!filter.includeRemoved) qb = qb.neq('status', 'removed');

  const { data, error } = await qb;
  if (error) {
    throw error;
  }

  // A disabled person is not part of the team (they cannot sign in), so they
  // are left out of every member read. A membership with no identity row is
  // skipped: there is no name or phone to show.
  return ((data ?? []) as unknown as MemberRow[])
    .filter((row) => row.users !== null && !row.users.disabled)
    .map((row) => ({
      userId: row.user_id,
      name: row.users!.name,
      countryCode: row.users!.country_code,
      phoneNumber: row.users!.phone_number,
      employeeCode: row.employee_code,
      role: row.role,
      status: row.status,
      createdAt: row.created_at,
      ...(filter.withSkills
        ? {
            skills: (row.users!.user_skills ?? []).flatMap((us) =>
              Array.isArray(us.skills) ? us.skills : us.skills ? [us.skills] : [],
            ),
          }
        : {}),
    }));
}

/** The member, or null when this person is not (any longer) in the company. */
export async function findCompanyMember(
  admin: SupabaseClient,
  tenantId: string,
  userId: string,
  filter: Omit<CompanyMemberFilter, 'userIds'> = {},
): Promise<CompanyMember | null> {
  const rows = await listCompanyMembers(admin, tenantId, {
    ...filter,
    userIds: [userId],
  });
  return rows[0] ?? null;
}
