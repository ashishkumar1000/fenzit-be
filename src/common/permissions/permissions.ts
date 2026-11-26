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
  | 'member.job_settings' // company admin of this company only (CAP-1)
  | 'member.employment' // company admin of this company only (CAP-13)
  | 'member.deactivate' // company admin of this company only: park/reinstate a member (2026-11-21)
  | 'member.manager' // company admin of this company only: set "Reports to" (24-1)
  | 'member.remove'
  | 'invite_sms.resend' // company admin of this company only (story 21-2)
  | 'user.disable' // platform only
  | 'user.manage' // platform only — inspect anyone by phone, flip account flags
  | 'audit.read'
  // jobs
  | 'job.read_all'
  | 'job.read_own'
  | 'job.write'
  | 'job.create_own' // an employee's own job, when the owner allows it (CAP-2)
  | 'job.approve' // tree-derived like leave.approve: guard lets it through, the resolved-approver walk decides (24-4)
  | 'job.reports' // company-wide owner surfaces (owner report + tenant approval queue) — admin only, NOT tree-derived; split out of job.approve in 24-4 when that grant widened
  | 'job.advance' // own workflow steps and attachments
  | 'job.sync' // own jobs to the app
  // customers and reports
  | 'customer.read'
  | 'customer.write'
  | 'report.read'
  | 'report.request' // request and retry (a viewer may, decision 39)
  | 'report.queue' // pause/resume the company's report queue (23-8) — admins only
  // attendance and leave
  | 'attendance.read' // all employees
  | 'attendance.manage'
  | 'attendance.own'
  | 'leave.read_all'
  | 'leave.read_team' // a manager's own subtree (24-2/CAP-2); employees and viewers hold it, the service scopes the rows
  | 'leave.approve' // approve, reject, revoke
  | 'leave.create_on_behalf'
  | 'leave.types' // the paid/unpaid catalog config (CAP-12), company admin of this company only
  | 'leave.own'
  // payroll configuration (epic 23): components, structures (CAP-1/2), and
  // later the calendar, heads and statutory config (CAP-4/6/8)
  | 'payroll.config' // company admin of this company only
  | 'payroll.own' // an employee's own payslips (history, month, PDF) — story 23-8
  // lookups
  | 'places.search'
  // app roadblocks (platform only, super admin)
  | 'app_config.manage'
  | 'tenant.validity.manage';

/** Permissions that make sense without a company (everything else needs one). */
export const PLATFORM_WIDE_PERMISSIONS: ReadonlySet<Permission> =
  new Set<Permission>([
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
  'report.queue',
  'attendance.read',
  'attendance.manage',
  'leave.read_all',
  'leave.approve',
  'leave.create_on_behalf',
  'places.search',
];

export const ROLE_PERMISSIONS: Readonly<Record<Role, ReadonlySet<Permission>>> =
  {
    [Role.PLATFORM_ADMIN]: new Set<Permission>([
      ...ADMIN_PERMISSIONS,
      'user.disable',
      'user.manage',
      'app_config.manage',
      'tenant.validity.manage',
    ]),
    // invite_sms.resend sits outside ADMIN_PERMISSIONS, so a platform admin (not a company member) does not get it.
    // member.job_settings, member.employment, member.deactivate, member.manager, leave.types, payroll.config, job.approve and payroll.own sit outside ADMIN_PERMISSIONS too, so a platform admin does not get them.
    [Role.COMPANY_ADMIN]: new Set<Permission>([
      ...ADMIN_PERMISSIONS,
      'invite_sms.resend',
      'member.job_settings',
      'member.employment',
      'member.deactivate',
      'member.manager',
      'leave.types',
      'payroll.config',
      'job.approve',
      // 24-4: the tenant-wide owner surfaces; outside ADMIN_PERMISSIONS so
      // staff (platform admins) do not inherit a company's queue/report.
      'job.reports',
    ]),
    [Role.EMPLOYEE]: new Set<Permission>([
      'job.read_own',
      'job.create_own',
      'job.advance',
      'job.sync',
      'customer.read',
      'attendance.own',
      'leave.own',
      'leave.read_team',
      'leave.create_on_behalf',
      // 24-3: approval rights are TREE-derived, not role-derived (D13). The
      // guard only lets the request reach the service; the resolved-approver
      // walk decides, and a member outside the set answers 403
      // NOT_AN_APPROVER. Without this grant a manager could never decide.
      'leave.approve',
      // 24-4: same tree-derived reading for jobs — a manager is an employee,
      // and the service refuses anyone outside the resolved set.
      'job.approve',
      'payroll.own',
    ]),
    [Role.VIEWER]: new Set<Permission>([
      'job.read_all',
      'customer.read',
      'report.read',
      'report.request',
      'attendance.read',
      // A viewer ASSIGNED as a manager reads their subtree's leave — the
      // deliberate D13 exception. Their job access is already company-wide.
      'leave.read_team',
      // ...and a viewer who is a manager keeps the tree-derived decision
      // right (D13: role changes never strip manager rights). The service
      // still refuses anyone outside the resolved set.
      'leave.approve',
      'job.approve',
    ]),
  };

/** What a signed-in person with no active company membership may do. */
export const NO_MEMBERSHIP_PERMISSIONS: ReadonlySet<Permission> =
  new Set<Permission>(['company.create_own']);

export function permissionsFor(role: Role | null): ReadonlySet<Permission> {
  return role === null ? NO_MEMBERSHIP_PERMISSIONS : ROLE_PERMISSIONS[role];
}

/**
 * The row scope a role's TEAM read gets (24-2/CAP-2). A role that already
 * holds the resource's company-wide permission keeps it — subtree rights are
 * additive to role rights, never a narrowing (D13), so a viewer keeps
 * `job.read_all` while gaining team leave. Every other role is subtree-scoped,
 * and the service enforces the rows because reads use the service-role client.
 * Kept here so the grant and the read scope cannot drift.
 */
export type ReadScope = 'tenant' | 'subtree';

export function readScopeFor(
  role: Role | null,
  companyWide: Permission,
): ReadScope {
  return permissionsFor(role).has(companyWide) ? 'tenant' : 'subtree';
}
