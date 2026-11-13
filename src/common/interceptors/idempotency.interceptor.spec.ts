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
    body?: unknown,
  ): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({
          headers,
          user,
          body,
          method: 'POST',
          url: '/api/v1/jobs/job-uuid/workflow',
        }),
      }),
    } as unknown as ExecutionContext;
  }

  // Pinned SHA-256 digests (computed outside the code under test). A change to
  // how the fingerprint is built must change these, so the test cannot pass by
  // recomputing the same mistake.
  // SHA-256 of the text `null` — the fingerprint of a request with no body.
  const HASH_OF_NO_BODY =
    '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b';
  // SHA-256 of the canonical (sorted-key) text of jobBody below.
  const HASH_OF_JOB_BODY =
    '9914fe64ec10717082f48425d4d229110692cc97a1519656e1a6515555013f40';

  // maybeSingle()-terminated lookup chain: .eq(key).eq(tenant_id).eq(scope).gt().
  function lookupChain(result: { data: unknown; error: unknown }) {
    const maybeSingle = jest.fn().mockResolvedValue(result);
    const gt = jest.fn().mockReturnValue({ maybeSingle });
    const eq3 = jest.fn().mockReturnValue({ gt });
    const eq2 = jest.fn().mockReturnValue({ eq: eq3 });
    const eq1 = jest.fn().mockReturnValue({ eq: eq2 });
    const select = jest.fn().mockReturnValue({ eq: eq1 });
    return { select, eq1, eq2, eq3, gt };
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
      request_hash: HASH_OF_NO_BODY,
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

  describe('request fingerprint — same key, different body', () => {
    const jobBody = {
      serviceLocation: 'Loc',
      scheduledStart: '2099-06-22T09:30:00Z',
      description: 'original',
    };

    it('retry with the same body → replays the saved answer, handler not called', async () => {
      const cached = { id: 'job-uuid' };
      const from = jest.fn().mockReturnValue(
        lookupChain({
          data: { response_body: cached, request_hash: HASH_OF_JOB_BODY },
          error: null,
        }),
      );
      factory.createAdmin.mockReturnValue({ from });

      const result$ = await interceptor.intercept(
        ctx({ 'x-idempotency-key': KEY }, user, jobBody),
        next,
      );

      expect(await lastValueFrom(result$)).toEqual(cached);
      expect(nextHandle).not.toHaveBeenCalled();
    });

    it('a retry whose JSON keys come in a different order still replays (no false 422)', async () => {
      const cached = { id: 'job-uuid' };
      const from = jest.fn().mockReturnValue(
        lookupChain({
          data: { response_body: cached, request_hash: HASH_OF_JOB_BODY },
          error: null,
        }),
      );
      factory.createAdmin.mockReturnValue({ from });
      // Same data as jobBody, keys written in another order, nested object too.
      const reordered = {
        description: 'original',
        serviceLocation: 'Loc',
        scheduledStart: '2099-06-22T09:30:00Z',
      };

      const result$ = await interceptor.intercept(
        ctx({ 'x-idempotency-key': KEY }, user, reordered),
        next,
      );

      expect(await lastValueFrom(result$)).toEqual(cached);
      expect(nextHandle).not.toHaveBeenCalled();
    });

    it('a nested object with keys in another order still matches the saved fingerprint', async () => {
      // Canonical text: {"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}
      const from = jest.fn().mockReturnValue(
        lookupChain({
          data: {
            response_body: { ok: true },
            request_hash:
              '8832acbc74cc8fd7c43b6cbd7d7ffa2eaa483de177cef59a6adc46cd5c503e1c',
          },
          error: null,
        }),
      );
      factory.createAdmin.mockReturnValue({ from });

      const result$ = await interceptor.intercept(
        ctx({ 'x-idempotency-key': KEY }, user, {
          b: 1,
          a: { d: 2, c: [3, { f: 4, e: 5 }] },
        }),
        next,
      );

      expect(await lastValueFrom(result$)).toEqual({ ok: true });
      expect(nextHandle).not.toHaveBeenCalled();
    });

    it('looks up by key, tenant and scope within 24h, selecting the answer and its fingerprint', async () => {
      jest.useFakeTimers({ now: new Date('2026-11-13T06:00:00Z') });
      try {
        const lookup = lookupChain({ data: null, error: null });
        const insert = jest.fn().mockResolvedValue({ error: null });
        const from = jest.fn(() => ({ ...lookup, insert }));
        factory.createAdmin.mockReturnValue({ from });

        const result$ = await interceptor.intercept(
          ctx({ 'x-idempotency-key': KEY }, user, jobBody),
          next,
        );
        await lastValueFrom(result$);

        expect(from).toHaveBeenCalledWith('idempotency_log');
        expect(lookup.select).toHaveBeenCalledWith(
          'response_body, request_hash',
        );
        expect(lookup.eq1).toHaveBeenCalledWith('key', KEY);
        expect(lookup.eq2).toHaveBeenCalledWith('tenant_id', 'tenant-uuid');
        expect(lookup.eq3).toHaveBeenCalledWith('scope', SCOPE);
        const since = new Date(
          Date.parse('2026-11-13T06:00:00Z') - 24 * 60 * 60 * 1000,
        ).toISOString();
        expect(lookup.gt).toHaveBeenCalledWith('created_at', since);
      } finally {
        jest.useRealTimers();
      }
    });

    it('same key with a different body → 422 IDEMPOTENCY_KEY_REUSED, first answer not replayed', async () => {
      const from = jest.fn().mockReturnValue(
        lookupChain({
          data: {
            response_body: { id: 'job-uuid' },
            request_hash: HASH_OF_JOB_BODY,
          },
          error: null,
        }),
      );
      factory.createAdmin.mockReturnValue({ from });

      const error: unknown = await interceptor
        .intercept(
          ctx({ 'x-idempotency-key': KEY }, user, {
            ...jobBody,
            description: 'changed',
          }),
          next,
        )
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(422);
      expect((error as HttpException).getResponse()).toEqual(
        expect.objectContaining({ error_code: 'IDEMPOTENCY_KEY_REUSED' }),
      );
      expect(nextHandle).not.toHaveBeenCalled();
    });

    it('an old row saved before fingerprints existed → replays whatever body is sent', async () => {
      const cached = { id: 'legacy-job' };
      const from = jest.fn().mockReturnValue(
        lookupChain({
          data: { response_body: cached, request_hash: null },
          error: null,
        }),
      );
      factory.createAdmin.mockReturnValue({ from });

      const result$ = await interceptor.intercept(
        ctx({ 'x-idempotency-key': KEY }, user, { anything: 'else' }),
        next,
      );

      expect(await lastValueFrom(result$)).toEqual(cached);
      expect(nextHandle).not.toHaveBeenCalled();
    });

    it('first request saves the SHA-256 fingerprint of its body with the answer', async () => {
      const insert = jest.fn().mockResolvedValue({ error: null });
      const from = jest.fn(() => ({
        ...lookupChain({ data: null, error: null }),
        insert,
      }));
      factory.createAdmin.mockReturnValue({ from });

      const result$ = await interceptor.intercept(
        ctx({ 'x-idempotency-key': KEY }, user, jobBody),
        next,
      );
      await lastValueFrom(result$);

      expect(insert).toHaveBeenCalledWith(
        expect.objectContaining({ request_hash: HASH_OF_JOB_BODY }),
      );
    });
  });
});
