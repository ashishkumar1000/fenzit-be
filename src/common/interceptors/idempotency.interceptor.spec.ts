import { CallHandler, ExecutionContext, HttpException } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { SupabaseClientFactory } from '../factories/supabase-client.factory';

const KEY = '11111111-1111-4111-8111-111111111111';

describe('IdempotencyInterceptor', () => {
  let interceptor: IdempotencyInterceptor;
  let factory: { create: jest.Mock; createAdmin: jest.Mock };

  // The handler emits this body when it runs.
  const handlerBody = { id: 'job-uuid', currentStep: 'on_my_way' };
  let nextHandle: jest.Mock;
  const next: CallHandler = {
    handle: (...args: unknown[]) => nextHandle(...args) as never,
  };

  beforeEach(() => {
    factory = { create: jest.fn(), createAdmin: jest.fn() };
    interceptor = new IdempotencyInterceptor(
      factory as unknown as SupabaseClientFactory,
    );
    nextHandle = jest.fn(() => of(handlerBody));
  });

  const SCOPE = 'POST:/api/v1/jobs/job-uuid/workflow';

  function ctx(
    headers: Record<string, unknown>,
    user: unknown,
  ): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({
          headers,
          user,
          method: 'POST',
          url: '/api/v1/jobs/job-uuid/workflow',
        }),
      }),
    } as unknown as ExecutionContext;
  }

  // maybeSingle()-terminated lookup chain: .eq(key).eq(tenant_id).eq(scope).gt().
  function lookupChain(result: { data: unknown; error: unknown }) {
    const maybeSingle = jest.fn().mockResolvedValue(result);
    const gt = jest.fn().mockReturnValue({ maybeSingle });
    const eq3 = jest.fn().mockReturnValue({ gt });
    const eq2 = jest.fn().mockReturnValue({ eq: eq3 });
    const eq1 = jest.fn().mockReturnValue({ eq: eq2 });
    const select = jest.fn().mockReturnValue({ eq: eq1 });
    return { select };
  }

  const user = { userId: 'tech-1', tenantId: 'tenant-uuid' };

  it('no header → passthrough, no DB lookup', async () => {
    await interceptor.intercept(ctx({}, user), next);
    expect(nextHandle).toHaveBeenCalled();
    expect(factory.createAdmin).not.toHaveBeenCalled();
  });

  it('malformed key → 422 thrown, no lookup', async () => {
    await expect(
      interceptor.intercept(
        ctx({ 'x-idempotency-key': 'not-a-uuid' }, user),
        next,
      ),
    ).rejects.toBeInstanceOf(HttpException);
    expect(factory.createAdmin).not.toHaveBeenCalled();
    expect(nextHandle).not.toHaveBeenCalled();
  });

  it('no tenant on user → passthrough', async () => {
    await interceptor.intercept(
      ctx({ 'x-idempotency-key': KEY }, { userId: 'tech-1', tenantId: null }),
      next,
    );
    expect(nextHandle).toHaveBeenCalled();
    expect(factory.createAdmin).not.toHaveBeenCalled();
  });

  it('cache hit → returns cached body, handler NOT called', async () => {
    const cached = { id: 'job-uuid', currentStep: 'cached' };
    const from = jest
      .fn()
      .mockReturnValue(
        lookupChain({ data: { response_body: cached }, error: null }),
      );
    factory.createAdmin.mockReturnValue({ from });

    const result$ = await interceptor.intercept(
      ctx({ 'x-idempotency-key': KEY }, user),
      next,
    );
    const body = await lastValueFrom(result$);

    expect(body).toEqual(cached);
    expect(nextHandle).not.toHaveBeenCalled();
  });

  it('cache miss → handler runs and insert is invoked with the response', async () => {
    const insert = jest.fn().mockResolvedValue({ error: null });
    const from = jest.fn((table: string) => {
      if (table === 'idempotency_log') {
        // First call = lookup (miss); the interceptor calls from() again for insert.
        return {
          ...lookupChain({ data: null, error: null }),
          insert,
        };
      }
      throw new Error(`unexpected table ${table}`);
    });
    factory.createAdmin.mockReturnValue({ from });

    const result$ = await interceptor.intercept(
      ctx({ 'x-idempotency-key': KEY }, user),
      next,
    );
    const body = await lastValueFrom(result$);

    expect(body).toEqual(handlerBody);
    expect(nextHandle).toHaveBeenCalled();
    expect(insert).toHaveBeenCalledWith({
      key: KEY,
      tenant_id: 'tenant-uuid',
      scope: SCOPE,
      response_body: handlerBody,
    });
  });

  it('lookup DB error → logged and treated as a miss (fail open)', async () => {
    const insert = jest.fn().mockResolvedValue({ error: null });
    const from = jest.fn(() => ({
      ...lookupChain({ data: null, error: { code: '08006' } }),
      insert,
    }));
    factory.createAdmin.mockReturnValue({ from });
    const logSpy = jest
      .spyOn(interceptor['logger'], 'error')
      .mockImplementation(() => undefined);

    const result$ = await interceptor.intercept(
      ctx({ 'x-idempotency-key': KEY }, user),
      next,
    );
    const body = await lastValueFrom(result$);

    // Fail open: a lookup error must not short-circuit; the handler still runs.
    expect(body).toEqual(handlerBody);
    expect(nextHandle).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('idempotency_log lookup failed', {
      error: { code: '08006' },
    });
  });

  it('insert 23505 (concurrent duplicate) is swallowed — request still resolves', async () => {
    const insert = jest.fn().mockResolvedValue({ error: { code: '23505' } });
    const from = jest.fn(() => ({
      ...lookupChain({ data: null, error: null }),
      insert,
    }));
    factory.createAdmin.mockReturnValue({ from });

    const result$ = await interceptor.intercept(
      ctx({ 'x-idempotency-key': KEY }, user),
      next,
    );
    const body = await lastValueFrom(result$);

    expect(body).toEqual(handlerBody);
    expect(insert).toHaveBeenCalled();
  });
});
