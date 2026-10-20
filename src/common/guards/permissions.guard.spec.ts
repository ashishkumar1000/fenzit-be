import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from './permissions.guard';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ANY_MEMBER_KEY } from '../decorators/any-member.decorator';
import { CAN_KEY } from '../decorators/can.decorator';
import { Role } from '../enums/role.enum';
import { Permission } from '../permissions/permissions';
import { RequestUser } from '../interfaces/request-user.interface';

const TENANT = '22222222-2222-4222-8222-222222222222';

interface Meta {
  isPublic?: boolean;
  anyMember?: boolean;
  can?: Permission[];
}

const userWith = (
  role: Role | null,
  tenantId: string | null = TENANT,
): RequestUser => ({
  userId: '11111111-1111-4111-8111-111111111111',
  tenantId,
  role,
  platformAdmin: role === Role.PLATFORM_ADMIN,
  rawJwt: 'jwt',
});

/** A context whose route metadata is exactly `meta`. */
const makeContext = (user: RequestUser | null | undefined, meta: Meta) => {
  const reflector = {
    getAllAndOverride: jest.fn((key: string) => {
      if (key === IS_PUBLIC_KEY) return meta.isPublic;
      if (key === ANY_MEMBER_KEY) return meta.anyMember;
      if (key === CAN_KEY) return meta.can;
      return undefined;
    }),
  } as unknown as Reflector;

  const ctx = {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;

  return { ctx, guard: new PermissionsGuard(reflector) };
};

const allows = (
  user: RequestUser | null | undefined,
  meta: Meta,
): boolean => {
  const { ctx, guard } = makeContext(user, meta);
  return guard.canActivate(ctx);
};

const refuses = (user: RequestUser | null | undefined, meta: Meta) => {
  const { ctx, guard } = makeContext(user, meta);
  try {
    guard.canActivate(ctx);
  } catch (e) {
    expect(e).toBeInstanceOf(ForbiddenException);
    return e as ForbiddenException;
  }
  throw new Error('expected the guard to refuse, but it allowed the request');
};

describe('PermissionsGuard', () => {
  describe('open routes', () => {
    it('allows a @Public route with no user', () => {
      expect(allows(undefined, { isPublic: true })).toBe(true);
    });

    it('allows @Public even when other decorators would refuse', () => {
      expect(
        allows(userWith(Role.VIEWER), { isPublic: true, can: ['job.write'] }),
      ).toBe(true);
    });

    it.each([Role.COMPANY_ADMIN, Role.EMPLOYEE, Role.VIEWER, Role.PLATFORM_ADMIN, null])(
      'allows an @AnyMember route for role %s',
      (role) => {
        expect(allows(userWith(role), { anyMember: true })).toBe(true);
      },
    );

    it('allows an @AnyMember route for a person with no company', () => {
      expect(allows(userWith(null, null), { anyMember: true })).toBe(true);
    });
  });

  describe('deny by default', () => {
    it('refuses an endpoint with none of @Public, @AnyMember or @Can', () => {
      for (const role of [Role.COMPANY_ADMIN, Role.PLATFORM_ADMIN, Role.EMPLOYEE, Role.VIEWER, null]) {
        expect(refuses(userWith(role), {}).getResponse()).toMatchObject({
          error_code: 'FORBIDDEN',
        });
      }
    });

    it('refuses an empty @Can() list', () => {
      refuses(userWith(Role.COMPANY_ADMIN), { can: [] });
    });

    it('refuses when no user is on the request', () => {
      refuses(null, { can: ['job.read_all'] });
      refuses(undefined, { can: ['job.read_all'] });
    });

    it('refuses explicit false flags', () => {
      refuses(userWith(Role.COMPANY_ADMIN), { isPublic: false, anyMember: false });
    });
  });

  describe('@Can with a role', () => {
    it('allows a company admin on an admin permission', () => {
      expect(allows(userWith(Role.COMPANY_ADMIN), { can: ['member.invite'] })).toBe(true);
    });

    it.each(['member.invite', 'job.write', 'customer.write', 'company.manage'] as const)(
      'refuses an employee and a viewer on %s',
      (permission) => {
        refuses(userWith(Role.EMPLOYEE), { can: [permission] });
        refuses(userWith(Role.VIEWER), { can: [permission] });
      },
    );

    it('refuses a company admin on an employee-only permission', () => {
      refuses(userWith(Role.COMPANY_ADMIN), { can: ['job.advance'] });
      refuses(userWith(Role.COMPANY_ADMIN), { can: ['attendance.own'] });
      refuses(userWith(Role.COMPANY_ADMIN), { can: ['job.sync'] });
    });

    it('lets a viewer read but not write or manage', () => {
      const viewer = userWith(Role.VIEWER);
      expect(allows(viewer, { can: ['customer.read'] })).toBe(true);
      expect(allows(viewer, { can: ['report.request'] })).toBe(true);
      refuses(viewer, { can: ['customer.write'] });
      refuses(viewer, { can: ['attendance.manage'] });
      refuses(viewer, { can: ['leave.read_all'] });
    });

    it('lets an employee do own-work permissions only', () => {
      const employee = userWith(Role.EMPLOYEE);
      expect(allows(employee, { can: ['job.advance'] })).toBe(true);
      expect(allows(employee, { can: ['leave.own'] })).toBe(true);
      refuses(employee, { can: ['report.read'] });
      refuses(employee, { can: ['places.search'] });
    });

    it('refuses with a plain message that does not name the permission', () => {
      const err = refuses(userWith(Role.EMPLOYEE), { can: ['job.write'] });
      expect(JSON.stringify(err.getResponse())).not.toContain('job.write');
    });
  });

  describe('any-of permission lists', () => {
    const jobRead: Permission[] = ['job.read_all', 'job.read_own'];

    it('allows an employee through job.read_own', () => {
      expect(allows(userWith(Role.EMPLOYEE), { can: jobRead })).toBe(true);
    });

    it('allows a viewer through job.read_all', () => {
      expect(allows(userWith(Role.VIEWER), { can: jobRead })).toBe(true);
    });

    it('allows a company admin through job.read_all', () => {
      expect(allows(userWith(Role.COMPANY_ADMIN), { can: jobRead })).toBe(true);
    });

    it('refuses a person with no membership when none of the list is held', () => {
      refuses(userWith(Role.EMPLOYEE), { can: ['job.write', 'customer.write'] });
      refuses(userWith(null, null), { can: jobRead });
    });

    it('is order independent', () => {
      expect(
        allows(userWith(Role.EMPLOYEE), { can: ['job.read_own', 'job.read_all'] }),
      ).toBe(true);
    });
  });

  describe('a person with no membership', () => {
    const nobody = userWith(null, null);

    it('may set up their own company', () => {
      expect(allows(nobody, { can: ['company.create_own'] })).toBe(true);
    });

    it.each(['job.read_all', 'job.read_own', 'member.read', 'customer.read', 'attendance.own', 'user.disable', 'audit.read'] as const)(
      'is refused %s',
      (permission) => {
        refuses(nobody, { can: [permission] });
      },
    );

    it('a company member cannot use company.create_own', () => {
      refuses(userWith(Role.COMPANY_ADMIN), { can: ['company.create_own'] });
      refuses(userWith(Role.EMPLOYEE), { can: ['company.create_own'] });
    });
  });

  describe('platform admin', () => {
    it('is allowed company permissions when a company is named', () => {
      const admin = userWith(Role.PLATFORM_ADMIN, TENANT);
      expect(allows(admin, { can: ['member.read'] })).toBe(true);
      expect(allows(admin, { can: ['job.read_all'] })).toBe(true);
    });

    it('is refused a company permission when no X-Company-Id was sent', () => {
      const admin = userWith(Role.PLATFORM_ADMIN, null);
      const err = refuses(admin, { can: ['member.read'] });
      expect(err.getResponse()).toMatchObject({
        error_code: 'FORBIDDEN',
        message: 'Name the company with the X-Company-Id header',
      });
      refuses(admin, { can: ['job.read_all'] });
      refuses(admin, { can: ['company.manage'] });
    });

    it.each(['user.disable', 'audit.read'] as const)(
      'is allowed platform-wide %s with no company',
      (permission) => {
        expect(allows(userWith(Role.PLATFORM_ADMIN, null), { can: [permission] })).toBe(true);
      },
    );

    it('holds user.disable, and a company admin does not', () => {
      expect(allows(userWith(Role.PLATFORM_ADMIN), { can: ['user.disable'] })).toBe(true);
      refuses(userWith(Role.COMPANY_ADMIN), { can: ['user.disable'] });
      refuses(userWith(Role.VIEWER), { can: ['user.disable'] });
    });

    it('does not hold employee-only permissions', () => {
      refuses(userWith(Role.PLATFORM_ADMIN), { can: ['job.advance'] });
      refuses(userWith(Role.PLATFORM_ADMIN), { can: ['attendance.own'] });
    });

    it('is not refused for a missing company when an any-of list includes a platform-wide permission it holds', () => {
      expect(
        allows(userWith(Role.PLATFORM_ADMIN, null), { can: ['audit.read', 'member.read'] }),
      ).toBe(true);
    });
  });

  describe('company admin without a tenant (defensive)', () => {
    it('is refused a company-scoped permission if tenantId is somehow null', () => {
      refuses(userWith(Role.COMPANY_ADMIN, null), { can: ['member.read'] });
    });

    it('still reaches audit.read (platform-wide) through its role', () => {
      expect(allows(userWith(Role.COMPANY_ADMIN, null), { can: ['audit.read'] })).toBe(true);
    });
  });
});
