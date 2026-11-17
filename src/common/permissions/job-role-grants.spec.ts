import { permissionsFor } from './permissions';
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
