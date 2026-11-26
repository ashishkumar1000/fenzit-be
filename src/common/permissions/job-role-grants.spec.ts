import { permissionsFor, readScopeFor } from './permissions';
import { Role } from '../enums/role.enum';

/**
 * Pins who may do the employee-created-jobs actions (stories 2-6). The guard
 * checks these sets, so dropping a grant would switch a feature off without any
 * service-level test failing.
 */
describe('job grants per role (employee-created jobs)', () => {
  it('an employee may create their own job (CAP-2) and read their own jobs', () => {
    expect(permissionsFor(Role.EMPLOYEE).has('job.create_own')).toBe(true);
    expect(permissionsFor(Role.EMPLOYEE).has('job.read_own')).toBe(true);
  });

  it('only a company admin may approve or reject (CAP-5)', () => {
    expect(permissionsFor(Role.COMPANY_ADMIN).has('job.approve')).toBe(true);
    expect(permissionsFor(Role.EMPLOYEE).has('job.approve')).toBe(false);
    expect(permissionsFor(Role.VIEWER).has('job.approve')).toBe(false);
    expect(permissionsFor(Role.PLATFORM_ADMIN).has('job.approve')).toBe(false);
  });

  it('a viewer cannot create jobs, and an admin does not get the employee self-create grant', () => {
    expect(permissionsFor(Role.VIEWER).has('job.create_own')).toBe(false);
    expect(permissionsFor(Role.COMPANY_ADMIN).has('job.create_own')).toBe(
      false,
    );
  });

  it('a platform admin with no company membership gets no job approval', () => {
    expect(permissionsFor(null).has('job.approve')).toBe(false);
    expect(permissionsFor(null).has('job.create_own')).toBe(false);
  });
});

/**
 * Pins the reporting-manager grant (24-1/CAP-1): the "Reports to" endpoint
 * sits behind `member.manager`, so a dropped grant switches the whole
 * hierarchy surface off without any service test failing. Outside
 * ADMIN_PERMISSIONS — staff do not edit a company's tree.
 */
describe('reporting-manager grant per role (24-1/CAP-1)', () => {
  it('only the company admin holds it', () => {
    expect(permissionsFor(Role.COMPANY_ADMIN).has('member.manager')).toBe(true);
    expect(permissionsFor(Role.EMPLOYEE).has('member.manager')).toBe(false);
    expect(permissionsFor(Role.VIEWER).has('member.manager')).toBe(false);
    expect(permissionsFor(Role.PLATFORM_ADMIN).has('member.manager')).toBe(
      false,
    );
  });

  it('a signed-in person with no company holds nothing of it', () => {
    expect(permissionsFor(null).has('member.manager')).toBe(false);
  });
});

/**
 * Pins the team-read grant and scope (24-2/CAP-2). The guard lets employees
 * and viewers hold `leave.read_team`; the SERVICE narrows the rows. Admins
 * keep `leave.read_all` and the tenant scope.
 */
describe('team-read grant and scope per role (24-2/CAP-2)', () => {
  it('employees and viewers may open the team list, managers or not', () => {
    expect(permissionsFor(Role.EMPLOYEE).has('leave.read_team')).toBe(true);
    expect(permissionsFor(Role.VIEWER).has('leave.read_team')).toBe(true);
  });

  it('an employee may file on behalf — the service limits it to their subtree', () => {
    expect(permissionsFor(Role.EMPLOYEE).has('leave.create_on_behalf')).toBe(
      true,
    );
    expect(permissionsFor(Role.VIEWER).has('leave.create_on_behalf')).toBe(
      false,
    );
  });

  it('approval rights are tree-derived: employees and viewers reach the service, which decides', () => {
    // 24-3: the guard must not be the approver filter — a manager is an
    // employee. The resolved-approver walk (and the admin override) decides.
    expect(permissionsFor(Role.EMPLOYEE).has('leave.approve')).toBe(true);
    expect(permissionsFor(Role.VIEWER).has('leave.approve')).toBe(true);
    expect(permissionsFor(Role.COMPANY_ADMIN).has('leave.approve')).toBe(true);
    // Filing on behalf stays narrower than deciding.
    expect(permissionsFor(Role.VIEWER).has('leave.create_on_behalf')).toBe(
      false,
    );
  });

  it('the whole-company grant stays admin-side', () => {
    expect(permissionsFor(Role.COMPANY_ADMIN).has('leave.read_all')).toBe(true);
    expect(permissionsFor(Role.PLATFORM_ADMIN).has('leave.read_all')).toBe(
      true,
    );
    expect(permissionsFor(Role.EMPLOYEE).has('leave.read_all')).toBe(false);
    expect(permissionsFor(Role.VIEWER).has('leave.read_all')).toBe(false);
  });

  it('leave is tenant-wide for admins, subtree for employees and viewers', () => {
    expect(readScopeFor(Role.COMPANY_ADMIN, 'leave.read_all')).toBe('tenant');
    expect(readScopeFor(Role.PLATFORM_ADMIN, 'leave.read_all')).toBe('tenant');
    expect(readScopeFor(Role.EMPLOYEE, 'leave.read_all')).toBe('subtree');
    expect(readScopeFor(Role.VIEWER, 'leave.read_all')).toBe('subtree');
    expect(readScopeFor(null, 'leave.read_all')).toBe('subtree');
  });

  it('jobs stay company-wide for a viewer — subtree rights never narrow a role (D13)', () => {
    expect(readScopeFor(Role.COMPANY_ADMIN, 'job.read_all')).toBe('tenant');
    expect(readScopeFor(Role.PLATFORM_ADMIN, 'job.read_all')).toBe('tenant');
    expect(readScopeFor(Role.VIEWER, 'job.read_all')).toBe('tenant');
    expect(readScopeFor(Role.EMPLOYEE, 'job.read_all')).toBe('subtree');
    // And leave/jobs agree wherever the role lacks the company-wide grant.
    expect(readScopeFor(Role.EMPLOYEE, 'leave.read_all')).toBe(
      readScopeFor(Role.EMPLOYEE, 'job.read_all'),
    );
  });
});

/**
 * Pins the employment-data grant (CAP-13, story 23-1) the same way: the
 * employment endpoints sit behind `member.employment`, so a dropped grant
 * switches the whole Form V surface off without any service test failing.
 */
describe('employment grant per role (payroll CAP-13)', () => {
  it('only the company admin holds it', () => {
    expect(permissionsFor(Role.COMPANY_ADMIN).has('member.employment')).toBe(
      true,
    );
    expect(permissionsFor(Role.EMPLOYEE).has('member.employment')).toBe(false);
    expect(permissionsFor(Role.VIEWER).has('member.employment')).toBe(false);
    expect(permissionsFor(Role.PLATFORM_ADMIN).has('member.employment')).toBe(
      false,
    );
  });

  it('a signed-in person with no company holds nothing of it', () => {
    expect(permissionsFor(null).has('member.employment')).toBe(false);
  });
});

/**
 * Pins the leave-type catalog grant (CAP-12, story 23-2) the same way: the
 * catalog config endpoints sit behind `leave.types`, so a dropped grant
 * switches the paid/unpaid configuration surface off without any service
 * test failing. Outside ADMIN_PERMISSIONS — a platform admin (staff, no
 * company) configures no tenant's payroll.
 */
describe('leave-type catalog grant per role (payroll CAP-12)', () => {
  it('only the company admin holds it', () => {
    expect(permissionsFor(Role.COMPANY_ADMIN).has('leave.types')).toBe(true);
    expect(permissionsFor(Role.EMPLOYEE).has('leave.types')).toBe(false);
    expect(permissionsFor(Role.VIEWER).has('leave.types')).toBe(false);
    expect(permissionsFor(Role.PLATFORM_ADMIN).has('leave.types')).toBe(false);
  });

  it('a signed-in person with no company holds nothing of it', () => {
    expect(permissionsFor(null).has('leave.types')).toBe(false);
  });
});

/**
 * Pins the payroll configuration grant (CAP-1/2, story 23-3): the component
 * library and salary-structure endpoints sit behind `payroll.config`, so a
 * dropped grant switches the whole payroll configuration surface off without
 * any service test failing. Outside ADMIN_PERMISSIONS — a platform admin
 * (staff, no company) configures no tenant's payroll.
 */
describe('payroll config grant per role (payroll CAP-1/2)', () => {
  it('only the company admin holds it', () => {
    expect(permissionsFor(Role.COMPANY_ADMIN).has('payroll.config')).toBe(true);
    expect(permissionsFor(Role.EMPLOYEE).has('payroll.config')).toBe(false);
    expect(permissionsFor(Role.VIEWER).has('payroll.config')).toBe(false);
    expect(permissionsFor(Role.PLATFORM_ADMIN).has('payroll.config')).toBe(
      false,
    );
  });

  it('a signed-in person with no company holds nothing of it', () => {
    expect(permissionsFor(null).has('payroll.config')).toBe(false);
  });
});
