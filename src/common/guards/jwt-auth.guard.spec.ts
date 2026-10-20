import {
  ExecutionContext,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { JwtAuthGuard } from './jwt-auth.guard';
import { MembershipResolver } from '../auth/membership-resolver';
import { Role } from '../enums/role.enum';
import { RequestUser } from '../interfaces/request-user.interface';
import {
  FakePerson,
  fakeMembershipResolver,
} from '../../../test/helpers/auth-test-utils';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_TENANT = '33333333-3333-4333-8333-333333333333';

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

/** A token payload a real login would mint. */
const loginClaims = (extra: Record<string, unknown> = {}) => ({
  sub: USER_ID,
  typ: 'access',
  iat: 1000,
  exp: 9999999999,
  ...extra,
});

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

  const build = (
    reflector: Reflector,
    people: FakePerson[] = [],
    companies: string[] = [],
  ) =>
    new JwtAuthGuard(
      jwtService,
      reflector,
      configService,
      fakeMembershipResolver(people, companies) as MembershipResolver,
    );

  const verifiesAs = (payload: Record<string, unknown>) =>
    (jwtService.verifyAsync as jest.Mock).mockResolvedValue(payload);

  const headers = (extra: Record<string, string> = {}) => ({
    authorization: 'Bearer valid-token',
    ...extra,
  });

  const userOf = (request: { user: unknown }) => request.user as RequestUser;

  it('passes through @Public() routes without a token', async () => {
    const { ctx, reflector } = makeContext({}, true);
    const resolver = { resolve: jest.fn(), companyExists: jest.fn() };
    const guard = new JwtAuthGuard(
      jwtService,
      reflector,
      configService,
      resolver as unknown as MembershipResolver,
    );

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(jwtService.verifyAsync).not.toHaveBeenCalled();
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it('throws 401 when Authorization header is missing', async () => {
    const { ctx, reflector } = makeContext({});
    await expect(build(reflector).canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('throws 401 when the scheme is not Bearer or the token is empty', async () => {
    for (const authorization of ['Basic abc', 'Bearer', 'Bearer ', 'abc']) {
      const { ctx, reflector } = makeContext({ authorization });
      await expect(build(reflector).canActivate(ctx)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    }
    expect(jwtService.verifyAsync).not.toHaveBeenCalled();
  });

  it('throws 401 when the signature is bad', async () => {
    (jwtService.verifyAsync as jest.Mock).mockRejectedValue(
      new Error('invalid signature'),
    );
    const { ctx, reflector } = makeContext({
      authorization: 'Bearer bad-token',
    });
    await expect(build(reflector).canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('throws 401 when the token is expired', async () => {
    (jwtService.verifyAsync as jest.Mock).mockRejectedValue(
      Object.assign(new Error('jwt expired'), { name: 'TokenExpiredError' }),
    );
    const { ctx, reflector } = makeContext(headers());
    const err = await build(reflector, [{ userId: USER_ID }])
      .canActivate(ctx)
      .catch((e) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect(err.response?.message).toBe('Invalid or expired token');
  });

  describe('tokens that must never open the API', () => {
    const expectRefused = async (payload: Record<string, unknown>) => {
      verifiesAs(payload);
      const { ctx, request, reflector } = makeContext(headers());
      const err = await build(reflector, [{ userId: USER_ID }])
        .canActivate(ctx)
        .catch((e) => e);
      expect(err).toBeInstanceOf(UnauthorizedException);
      // Its own message, not the generic verify-failure rewrite.
      expect(err.response?.message).toBe('Token is not valid for API access');
      expect(request.user).toBeUndefined();
    };

    it('rejects a Realtime token (role "authenticated", no typ)', async () => {
      await expectRefused({
        sub: USER_ID,
        role: 'authenticated',
        iat: 1000,
        exp: 9999999999,
      });
    });

    it('rejects a service-role style token (no typ, no sub)', async () => {
      await expectRefused({ role: 'service_role', iss: 'supabase' });
    });

    it('rejects an old-style token carrying role + tenantId but no typ', async () => {
      await expectRefused({
        sub: USER_ID,
        tenantId: TENANT_ID,
        role: 'owner',
        iat: 1000,
        exp: 9999999999,
      });
    });

    it('rejects a token with a typ other than "access"', async () => {
      await expectRefused(loginClaims({ typ: 'refresh' }));
      await expectRefused(loginClaims({ typ: 'ACCESS' }));
      await expectRefused(loginClaims({ typ: true }));
    });

    it('rejects a token whose sub is not a UUID', async () => {
      await expectRefused(loginClaims({ sub: 'user-123' }));
      await expectRefused(loginClaims({ sub: '' }));
      await expectRefused(loginClaims({ sub: `${USER_ID}x` }));
      await expectRefused(loginClaims({ sub: 12345 }));
    });

    it('rejects a token with no sub at all', async () => {
      await expectRefused({ typ: 'access', iat: 1000, exp: 9999999999 });
    });
  });

  describe('access comes from the database', () => {
    it('refuses an unknown user with the generic 401', async () => {
      verifiesAs(loginClaims());
      const { ctx, request, reflector } = makeContext(headers());
      const err = await build(reflector, [])
        .canActivate(ctx)
        .catch((e) => e);
      expect(err).toBeInstanceOf(UnauthorizedException);
      expect(err.response?.message).toBe('Invalid or expired token');
      expect(request.user).toBeUndefined();
    });

    it('refuses a disabled user with the same generic 401', async () => {
      verifiesAs(loginClaims());
      const { ctx, request, reflector } = makeContext(headers());
      const err = await build(reflector, [
        { userId: USER_ID, tenantId: TENANT_ID, role: Role.COMPANY_ADMIN, disabled: true },
      ])
        .canActivate(ctx)
        .catch((e) => e);
      expect(err).toBeInstanceOf(UnauthorizedException);
      expect(err.response?.message).toBe('Invalid or expired token');
      expect(request.user).toBeUndefined();
    });

    it('returns 500 when the access lookup throws', async () => {
      verifiesAs(loginClaims());
      const { ctx, reflector } = makeContext(headers());
      const guard = new JwtAuthGuard(jwtService, reflector, configService, {
        resolve: jest.fn().mockRejectedValue(new Error('db down')),
        companyExists: jest.fn(),
      } as unknown as MembershipResolver);
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });

    it('populates request.user from the active membership, not the claims', async () => {
      // Stale / forged claims must be ignored: only the database counts.
      verifiesAs(
        loginClaims({ role: 'owner', tenantId: OTHER_TENANT, platformAdmin: true }),
      );
      const { ctx, request, reflector } = makeContext(
        headers({ 'x-company-id': OTHER_TENANT }),
      );
      const guard = build(reflector, [
        { userId: USER_ID, tenantId: TENANT_ID, role: Role.EMPLOYEE },
      ]);

      await expect(guard.canActivate(ctx)).resolves.toBe(true);

      expect(userOf(request)).toEqual({
        userId: USER_ID,
        tenantId: TENANT_ID,
        role: Role.EMPLOYEE,
        platformAdmin: false,
        rawJwt: 'valid-token',
      });
    });

    it('gives a company admin and a viewer the role the database holds', async () => {
      for (const role of [Role.COMPANY_ADMIN, Role.VIEWER] as const) {
        verifiesAs(loginClaims());
        const { ctx, request, reflector } = makeContext(headers());
        await build(reflector, [
          { userId: USER_ID, tenantId: TENANT_ID, role },
        ]).canActivate(ctx);
        expect(userOf(request).role).toBe(role);
        expect(userOf(request).tenantId).toBe(TENANT_ID);
      }
    });

    it('gives a person with no membership role null and tenant null', async () => {
      verifiesAs(loginClaims());
      const { ctx, request, reflector } = makeContext(headers());
      await build(reflector, [{ userId: USER_ID }]).canActivate(ctx);
      expect(userOf(request)).toMatchObject({
        userId: USER_ID,
        role: null,
        tenantId: null,
        platformAdmin: false,
      });
    });
  });

  describe('platform admin and X-Company-Id', () => {
    const admin: FakePerson = { userId: USER_ID, platformAdmin: true };

    it('acts on the named company as role platform_admin', async () => {
      verifiesAs(loginClaims());
      const { ctx, request, reflector } = makeContext(
        headers({ 'x-company-id': TENANT_ID }),
      );
      await build(reflector, [admin], [TENANT_ID]).canActivate(ctx);
      expect(userOf(request)).toMatchObject({
        role: Role.PLATFORM_ADMIN,
        tenantId: TENANT_ID,
        platformAdmin: true,
      });
    });

    it('has tenantId null when no header is sent', async () => {
      verifiesAs(loginClaims());
      const { ctx, request, reflector } = makeContext(headers());
      await build(reflector, [admin], [TENANT_ID]).canActivate(ctx);
      expect(userOf(request)).toMatchObject({
        role: Role.PLATFORM_ADMIN,
        tenantId: null,
        platformAdmin: true,
      });
    });

    it('stays platform_admin even when the admin also has a company membership', async () => {
      verifiesAs(loginClaims());
      const { ctx, request, reflector } = makeContext(headers());
      await build(
        reflector,
        [{ ...admin, tenantId: TENANT_ID, role: Role.EMPLOYEE }],
        [TENANT_ID],
      ).canActivate(ctx);
      // The membership company is not silently used: the header names it.
      expect(userOf(request)).toMatchObject({
        role: Role.PLATFORM_ADMIN,
        tenantId: null,
      });
    });

    it('returns 404 for a company that does not exist', async () => {
      verifiesAs(loginClaims());
      const { ctx, request, reflector } = makeContext(
        headers({ 'x-company-id': OTHER_TENANT }),
      );
      const err = await build(reflector, [admin], [TENANT_ID])
        .canActivate(ctx)
        .catch((e) => e);
      expect(err).toBeInstanceOf(NotFoundException);
      expect(err.response?.error_code).toBe('RESOURCE_NOT_FOUND');
      expect(request.user).toBeUndefined();
    });

    it('returns 404 for a header that is not a UUID, without asking the database', async () => {
      verifiesAs(loginClaims());
      const companyExists = jest.fn().mockResolvedValue(true);
      const { ctx, reflector } = makeContext(
        headers({ 'x-company-id': "1' or '1'='1" }),
      );
      const guard = new JwtAuthGuard(jwtService, reflector, configService, {
        resolve: jest.fn().mockResolvedValue({
          userId: USER_ID,
          platformAdmin: true,
          disabled: false,
          membership: null,
        }),
        companyExists,
      } as unknown as MembershipResolver);
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(companyExists).not.toHaveBeenCalled();
    });

    it('treats an empty header as absent', async () => {
      verifiesAs(loginClaims());
      const { ctx, request, reflector } = makeContext(
        headers({ 'x-company-id': '' }),
      );
      await build(reflector, [admin]).canActivate(ctx);
      expect(userOf(request).tenantId).toBeNull();
    });

    it('ignores the header for a company member (no 404, no company switch)', async () => {
      verifiesAs(loginClaims());
      const { ctx, request, reflector } = makeContext(
        headers({ 'x-company-id': OTHER_TENANT }),
      );
      await build(reflector, [
        { userId: USER_ID, tenantId: TENANT_ID, role: Role.COMPANY_ADMIN },
      ]).canActivate(ctx);
      expect(userOf(request)).toMatchObject({
        tenantId: TENANT_ID,
        role: Role.COMPANY_ADMIN,
        platformAdmin: false,
      });
    });

    it('ignores the header for a person with no membership', async () => {
      verifiesAs(loginClaims());
      const { ctx, request, reflector } = makeContext(
        headers({ 'x-company-id': TENANT_ID }),
      );
      await build(reflector, [{ userId: USER_ID }], [TENANT_ID]).canActivate(
        ctx,
      );
      expect(userOf(request).tenantId).toBeNull();
      expect(userOf(request).role).toBeNull();
    });
  });
});
