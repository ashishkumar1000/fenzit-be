import { ExecutionContext, Logger } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import { PlatformAuditInterceptor } from './platform-audit.interceptor';
import { SupabaseClientFactory } from '../factories/supabase-client.factory';
import { RequestUser } from '../interfaces/request-user.interface';
import { Role } from '../enums/role.enum';

const TARGET = '33333333-3333-3333-3333-333333333333';

const staff: RequestUser = {
  userId: 'staff-1',
  tenantId: 'tenant-A',
  role: null,
  platformAdmin: true,
  rawJwt: 'jwt',
};

const companyAdmin: RequestUser = {
  userId: 'admin-1',
  tenantId: 'tenant-A',
  role: Role.COMPANY_ADMIN,
  platformAdmin: false,
  rawJwt: 'jwt',
};

function setup(opts: {
  method: string;
  user?: RequestUser;
  url?: string;
  routeUrl?: string;
  params?: Record<string, unknown>;
  rpcResult?: { error: unknown };
}) {
  const rpc = jest
    .fn()
    .mockResolvedValue({ data: null, error: opts.rpcResult?.error ?? null });
  const factory = {
    createAdmin: jest.fn(() => ({ rpc })),
  } as unknown as SupabaseClientFactory;
  const request = {
    method: opts.method,
    url: opts.url ?? '/admin/users/x/disable',
    routeOptions: opts.routeUrl ? { url: opts.routeUrl } : undefined,
    params: opts.params ?? {},
    user: opts.user,
  };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { interceptor: new PlatformAuditInterceptor(factory), context, rpc };
}

/** Let the fire-and-forget audit insert finish before asserting on it. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

const handled = (value: unknown = { ok: true }) => ({
  handle: () => of(value),
});

describe('PlatformAuditInterceptor', () => {
  let errorSpy: jest.SpyInstance;
  beforeEach(() => {
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => errorSpy.mockRestore());

  it('records a platform-admin write after it succeeds, with the method and route', async () => {
    const { interceptor, context, rpc } = setup({
      method: 'POST',
      user: staff,
      routeUrl: '/admin/users/:userId/disable',
      params: { userId: TARGET },
    });
    await lastValueFrom(interceptor.intercept(context, handled()));
    await flush();
    expect(rpc).toHaveBeenCalledWith('write_audit_row', {
      p_actor: 'staff-1',
      p_action: 'platform.write POST /admin/users/:userId/disable',
      p_tenant_id: 'tenant-A',
      p_target_user: TARGET,
      p_details: { method: 'POST', route: '/admin/users/:userId/disable' },
    });
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'treats %s as a write',
    async (method) => {
      const { interceptor, context, rpc } = setup({ method, user: staff });
      await lastValueFrom(interceptor.intercept(context, handled()));
      await flush();
      expect(rpc).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['GET', 'HEAD', 'OPTIONS'])(
    'does not record a %s read',
    async (method) => {
      const { interceptor, context, rpc } = setup({ method, user: staff });
      await lastValueFrom(interceptor.intercept(context, handled()));
      await flush();
      expect(rpc).not.toHaveBeenCalled();
    },
  );

  it('does not record a write by a company admin (only platform staff are audited here)', async () => {
    const { interceptor, context, rpc } = setup({
      method: 'PATCH',
      user: companyAdmin,
    });
    await lastValueFrom(interceptor.intercept(context, handled()));
    await flush();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('does not record anything when the request has no caller', async () => {
    const { interceptor, context, rpc } = setup({ method: 'POST' });
    await lastValueFrom(interceptor.intercept(context, handled()));
    await flush();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('records nothing for a write that was refused, so a failed call is not logged as done', async () => {
    const { interceptor, context, rpc } = setup({
      method: 'POST',
      user: staff,
    });
    const refused = { handle: () => throwError(() => new Error('forbidden')) };
    await expect(
      lastValueFrom(interceptor.intercept(context, refused)),
    ).rejects.toThrow('forbidden');
    await flush();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('records no target when the user id in the path is not a UUID', async () => {
    const { interceptor, context, rpc } = setup({
      method: 'POST',
      user: staff,
      params: { userId: "x'; drop table users;--" },
    });
    await lastValueFrom(interceptor.intercept(context, handled()));
    await flush();
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({ p_target_user: null });
  });

  it('records no target for a route that names no person', async () => {
    const { interceptor, context, rpc } = setup({
      method: 'POST',
      user: staff,
      params: {},
    });
    await lastValueFrom(interceptor.intercept(context, handled()));
    await flush();
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({ p_target_user: null });
  });

  it('falls back to the path without its query string when the route is unknown', async () => {
    const { interceptor, context, rpc } = setup({
      method: 'POST',
      user: staff,
      url: '/admin/things?debug=1',
    });
    await lastValueFrom(interceptor.intercept(context, handled()));
    await flush();
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({
      p_action: 'platform.write POST /admin/things',
    });
  });

  it('caps the action text so one long route cannot overflow the audit column', async () => {
    const { interceptor, context, rpc } = setup({
      method: 'POST',
      user: staff,
      routeUrl: `/${'a'.repeat(400)}`,
    });
    await lastValueFrom(interceptor.intercept(context, handled()));
    await flush();
    const action = rpc.mock.calls[0]?.[1].p_action as string;
    expect(action.length).toBeLessThanOrEqual(200);
  });

  it('a failed audit insert is logged and never breaks the response that already succeeded', async () => {
    const { interceptor, context } = setup({
      method: 'POST',
      user: staff,
      rpcResult: { error: { code: '57P01', message: 'down' } },
    });
    await expect(
      lastValueFrom(interceptor.intercept(context, handled({ done: true }))),
    ).resolves.toEqual({ done: true });
    await flush();
    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to audit a platform-admin write',
      expect.objectContaining({ code: '57P01' }),
    );
  });

  it('a thrown audit call is caught and logged, not an unhandled rejection', async () => {
    const { interceptor, context, rpc } = setup({ method: 'POST', user: staff });
    rpc.mockRejectedValueOnce(new Error('network reset'));
    await expect(
      lastValueFrom(interceptor.intercept(context, handled({ done: true }))),
    ).resolves.toEqual({ done: true });
    await flush();
    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to audit a platform-admin write',
      expect.stringContaining('network reset'),
    );
  });
});
