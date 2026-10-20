/**
 * The four roles (roles-and-access-spec.md).
 *
 * `platform_admin` is a flag on the user (fenzit staff), never a membership.
 * The other three are the role on a company membership.
 */
export enum Role {
  PLATFORM_ADMIN = 'platform_admin',
  COMPANY_ADMIN = 'company_admin',
  EMPLOYEE = 'employee',
  VIEWER = 'viewer',
}

/** Roles a membership row can hold (matches memberships_role_check). */
export const MEMBERSHIP_ROLES = [
  Role.COMPANY_ADMIN,
  Role.EMPLOYEE,
  Role.VIEWER,
] as const;

export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];
