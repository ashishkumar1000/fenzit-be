import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { JwtAuthGuard } from './jwt-auth.guard';
import { Role } from '../enums/role.enum';

const makeContext = (headers: Record<string, string>, isPublic = false) => {
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(isPublic),
  } as unknown as Reflector;

  const request = { headers, user: undefined as unknown };

  const ctx = {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;

  return { ctx, request, reflector };
};

describe('JwtAuthGuard', () => {
  let jwtService: JwtService;
  let configService: ConfigService;

  beforeEach(() => {
    jwtService = {
      verifyAsync: jest.fn(),
    } as unknown as JwtService;

    configService = {
      getOrThrow: jest.fn().mockReturnValue('test-secret'),
    } as unknown as ConfigService;
  });

  it('passes through @Public() routes without a token', async () => {
    const { ctx, reflector } = makeContext({}, true);
    const guard = new JwtAuthGuard(jwtService, reflector, configService);

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(jwtService.verifyAsync).not.toHaveBeenCalled();
  });

  it('throws 401 when Authorization header is missing', async () => {
    const { ctx, reflector } = makeContext({});
    const guard = new JwtAuthGuard(jwtService, reflector, configService);

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('throws 401 when token is invalid', async () => {
    (jwtService.verifyAsync as jest.Mock).mockRejectedValue(
      new Error('invalid signature'),
    );

    const { ctx, reflector } = makeContext({
      authorization: 'Bearer bad-token',
    });
    const guard = new JwtAuthGuard(jwtService, reflector, configService);

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('populates request.user on a valid token', async () => {
    const payload = {
      sub: 'user-123',
      tenantId: 'tenant-abc',
      role: Role.OWNER,
      iat: 1000,
      exp: 9999999999,
    };
    (jwtService.verifyAsync as jest.Mock).mockResolvedValue(payload);

    const { ctx, request, reflector } = makeContext({
      authorization: 'Bearer valid-token',
    });
    const guard = new JwtAuthGuard(jwtService, reflector, configService);

    await expect(guard.canActivate(ctx)).resolves.toBe(true);

    const user = (
      request as {
        user: { userId: string; tenantId: string; role: Role; rawJwt: string };
      }
    ).user;
    expect(user.userId).toBe('user-123');
    expect(user.tenantId).toBe('tenant-abc');
    expect(user.role).toBe(Role.OWNER);
    expect(user.rawJwt).toBe('valid-token');
  });
});
