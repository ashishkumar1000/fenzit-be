import { Role } from '../enums/role.enum';

/**
 * Every permission an endpoint can require (decision 20). Names follow
 * `resource.action`. Endpoints declare one with `@Can(...)`; this file is the
 * ONLY place that says which role holds which permission, so a new role is one
 * change here. It is a typed constant, reviewed like any code (not a table).
 */
export type Permission =
  // companies and people
  | 'company.create_own' // a signed-in person with no company sets up their own
  | 'company.manage' // company profile
  | 'member.invite'
  | 'member.read'
  | 'member.change_role'
  | 'member.remove'
  | 'invite_sms.resend' // company admin of this company only (story 21-2)
  | 'user.disable' // platform only
  | 'user.manage' // platform only — inspect anyone by phone, flip account flags
  | 'audit.read'
  // jobs
  | 'job.read_all'
  | 'job.read_own'
  | 'job.write'
  | 'job.advance' // own workflow steps and attachments
  | 'job.sync' // own jobs to the app
  // customers and reports
  | 'customer.read'
  | 'customer.write'
  | 'report.read'
  | 'report.request' // request and retry (a viewer may, decision 39)
  // attendance and leave
  | 'attendance.read' // all employees
  | 'attendance.manage'
  | 'attendance.own'
  | 'leave.read_all'
  | 'leave.approve' // approve, reject, revoke
  | 'leave.create_on_behalf'
  | 'leave.own'
  // lookups
  | 'places.search'
  // app roadblocks (platform only, super admin)
  | 'app_config.manage'
  | 'tenant.validity.manage';

/** Permissions that make sense without a company (everything else needs one). */
export const PLATFORM_WIDE_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'company.create_own',
  'user.disable',
  'user.manage',
  'audit.read',
  'app_config.manage',
  'tenant.validity.manage',
]);

const ADMIN_PERMISSIONS: Permission[] = [
  'company.manage',
  'member.invite',
  'member.read',
  'member.change_role',
  'member.remove',
  'audit.read',
  'job.read_all',
  'job.write',
  'customer.read',
  'customer.write',
  'report.read',
  'report.request',
  'attendance.read',
  'attendance.manage',
  'leave.read_all',
  'leave.approve',
  'leave.create_on_behalf',
  'places.search',
];

export const ROLE_PERMISSIONS: Readonly<Record<Role, ReadonlySet<Permission>>> = {
  [Role.PLATFORM_ADMIN]: new Set<Permission>([
    ...ADMIN_PERMISSIONS,
    'user.disable',
    'user.manage',
    'app_config.manage',
    'tenant.validity.manage',
  ]),
  // invite_sms.resend sits outside ADMIN_PERMISSIONS, so a platform admin (not a company member) does not get it.
  [Role.COMPANY_ADMIN]: new Set<Permission>([...ADMIN_PERMISSIONS, 'invite_sms.resend']),
  [Role.EMPLOYEE]: new Set<Permission>([
    'job.read_own',
    'job.advance',
    'job.sync',
    'customer.read',
    'attendance.own',
    'leave.own',
  ]),
  [Role.VIEWER]: new Set<Permission>([
    'job.read_all',
    'customer.read',
    'report.read',
    'report.request',
    'attendance.read',
  ]),
};

/** What a signed-in person with no active company membership may do. */
export const NO_MEMBERSHIP_PERMISSIONS: ReadonlySet<Permission> =
  new Set<Permission>(['company.create_own']);

export function permissionsFor(role: Role | null): ReadonlySet<Permission> {
  return role === null ? NO_MEMBERSHIP_PERMISSIONS : ROLE_PERMISSIONS[role];
}
