import { ExecutionContext } from '@nestjs/common';
import { EMPTY, Observable } from 'rxjs';
import { getCorrelationContext } from './correlation.context';
import { CorrelationInterceptor, CorrelatedRequest } from './correlation.interceptor';

const CORRELATION = '11111111-2222-4333-8444-555555555555';
const SESSION = '9abcdef0-1234-4567-8abc-def012345678';

const makeContext = (headers: Record<string, string> = {}, user: unknown = null) => {
  const request = {
    method: 'GET',
    url: '/health',
    headers,
    user,
  } as unknown as CorrelatedRequest;
  const response = { header: jest.fn() };

  const ctx = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;

  return { ctx, request, response };
};

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** CallHandler whose observable completes immediately. */
const EMPTY_STUB = { handle: () => EMPTY };

describe('CorrelationInterceptor', () => {
  it('accepts and echoes valid correlation + session headers', () => {
    const interceptor = new CorrelationInterceptor();
    const { ctx, request, response } = makeContext({
      'x-correlation-id': CORRELATION,
      'x-session-id': SESSION,
    });

    interceptor.intercept(ctx, EMPTY_STUB).subscribe();

    expect(request.correlationId).toBe(CORRELATION);
    expect(request.sessionId).toBe(SESSION);
    expect(response.header).toHaveBeenCalledWith('x-correlation-id', CORRELATION);
    expect(response.header).toHaveBeenCalledWith('x-session-id', SESSION);
  });

  it('mints a UUID when the correlation header is missing', () => {
    const interceptor = new CorrelationInterceptor();
    const { ctx, request, response } = makeContext();

    interceptor.intercept(ctx, EMPTY_STUB).subscribe();

    expect(request.correlationId).toMatch(UUID_SHAPE);
    expect(request.sessionId).toBeNull();
    expect(response.header).toHaveBeenCalledWith(
      'x-correlation-id',
      request.correlationId,
    );
    // No session id — the backend never fabricates one.
    expect(response.header).not.toHaveBeenCalledWith(
      'x-session-id',
      expect.anything(),
    );
  });

  it('rejects an injection payload and never echoes it', () => {
    const interceptor = new CorrelationInterceptor();
    const { ctx, request, response } = makeContext({
      'x-correlation-id': 'FAKE-LOG-LINE-INJECT',
    });

    interceptor.intercept(ctx, EMPTY_STUB).subscribe();

    expect(request.correlationId).toMatch(UUID_SHAPE);
    expect(response.header).toHaveBeenCalledWith(
      'x-correlation-id',
      request.correlationId,
    );
    expect(response.header).not.toHaveBeenCalledWith(
      'x-correlation-id',
      'FAKE-LOG-LINE-INJECT',
    );
  });

  it('rejects an over-length header', () => {
    const interceptor = new CorrelationInterceptor();
    const longValid = `${CORRELATION}0000`; // 36 valid chars + junk
    const { ctx, request } = makeContext({ 'x-correlation-id': longValid });

    interceptor.intercept(ctx, EMPTY_STUB).subscribe();

    expect(request.correlationId).toMatch(UUID_SHAPE);
    expect(request.correlationId).not.toBe(longValid);
  });

  it('echoes the session header only when it is a valid UUID', () => {
    const interceptor = new CorrelationInterceptor();
    const { ctx, response } = makeContext({ 'x-session-id': 'not-a-uuid' });

    interceptor.intercept(ctx, EMPTY_STUB).subscribe();

    expect(response.header).not.toHaveBeenCalledWith(
      'x-session-id',
      expect.anything(),
    );
  });

  it('warns (without the raw value) when a session header is present but invalid', () => {
    const interceptor = new CorrelationInterceptor();
    const warnSpy = jest.spyOn(interceptor['logger'], 'warn').mockImplementation();
    const { ctx, response } = makeContext({ 'x-session-id': 'FAKE-SESSION-INJECT' });

    interceptor.intercept(ctx, EMPTY_STUB).subscribe();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).not.toContain('FAKE-SESSION-INJECT');
    expect(response.header).not.toHaveBeenCalledWith(
      'x-session-id',
      expect.anything(),
    );
  });

  it('does not warn when the session header is simply absent', () => {
    const interceptor = new CorrelationInterceptor();
    const warnSpy = jest.spyOn(interceptor['logger'], 'warn').mockImplementation();
    const { ctx } = makeContext();

    interceptor.intercept(ctx, EMPTY_STUB).subscribe();

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('exposes userId/tenantId from request.user (never from headers)', () => {
    const interceptor = new CorrelationInterceptor();
    const user = { userId: 'user-1', tenantId: 'tenant-1' };
    const { ctx, request } = makeContext(
      { 'x-correlation-id': CORRELATION },
      user,
    );

    let seen: ReturnType<typeof getCorrelationContext> = null;
    interceptor
      .intercept(ctx, {
        handle: () =>
          new Observable<void>((subscriber) => {
            seen = getCorrelationContext();
            subscriber.complete();
          }),
      })
      .subscribe();

    expect(seen).toEqual({
      correlationId: CORRELATION,
      sessionId: null,
      userId: 'user-1',
      tenantId: 'tenant-1',
    });
    expect(request.correlationId).toBe(CORRELATION);
  });

  it('keeps the ALS store active while the handler runs', (done) => {
    const interceptor = new CorrelationInterceptor();
    const { ctx } = makeContext({ 'x-correlation-id': CORRELATION });

    let seen: ReturnType<typeof getCorrelationContext> = null;
    interceptor
      .intercept(ctx, {
        handle: () =>
          new Observable<void>((subscriber) => {
            seen = getCorrelationContext();
            subscriber.next();
            subscriber.complete();
          }),
      })
      .subscribe(() => {
        // The handler ran inside the store's lifetime — the whole point of
        // wrapping the subscription instead of intercept() itself.
        expect(seen?.correlationId).toBe(CORRELATION);
        done();
      });
  });
});
