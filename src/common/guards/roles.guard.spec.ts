import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { Role } from '../enums/role.enum';

const makeContext = (
  user: { role: Role } | null,
  requiredRoles: Role[] | null,
) => {
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(requiredRoles),
  } as unknown as Reflector;

  const ctx = {
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;

  return { ctx, reflector };
};

describe('RolesGuard', () => {
  it('allows access when no roles are required', () => {
    const { ctx, reflector } = makeContext({ role: Role.TECHNICIAN }, null);
    const guard = new RolesGuard(reflector);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('allows owner to access owner-only route', () => {
    const { ctx, reflector } = makeContext({ role: Role.OWNER }, [Role.OWNER]);
    const guard = new RolesGuard(reflector);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('throws 403 when technician accesses owner-only route', () => {
    const { ctx, reflector } = makeContext({ role: Role.TECHNICIAN }, [
      Role.OWNER,
    ]);
    const guard = new RolesGuard(reflector);
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('throws 403 when owner accesses technician-only route', () => {
    const { ctx, reflector } = makeContext({ role: Role.OWNER }, [
      Role.TECHNICIAN,
    ]);
    const guard = new RolesGuard(reflector);
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('throws 403 when user is null', () => {
    const { ctx, reflector } = makeContext(null, [Role.OWNER]);
    const guard = new RolesGuard(reflector);
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });
});
