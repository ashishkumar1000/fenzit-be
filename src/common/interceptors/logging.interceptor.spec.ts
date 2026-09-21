import { ExecutionContext } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { LoggingInterceptor } from './logging.interceptor';

const makeContext = (
  extras: { user?: unknown; correlationId?: string; sessionId?: string | null } = {},
) => {
  const request = {
    method: 'GET',
    url: '/health',
    headers: {},
    user: extras.user ?? null,
    correlationId: extras.correlationId,
    sessionId: extras.sessionId,
  };
  const response = { statusCode: 200, header: jest.fn() };

  const ctx = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;

  return { ctx, request };
};

describe('LoggingInterceptor', () => {
  it('logs the correlation-context field set (no request_id)', (done) => {
    const interceptor = new LoggingInterceptor();
    const logSpy = jest.spyOn(interceptor['logger'], 'log');

    const { ctx } = makeContext({ correlationId: '11111111-2222-4333-8444-555555555555' });
    const next = { handle: () => of('ok') };

    interceptor.intercept(ctx, next).subscribe(() => {
      expect(logSpy).toHaveBeenCalledTimes(1);

      const logArg = (logSpy.mock.calls[0] as string[])[0];
      const parsed = JSON.parse(logArg) as Record<string, unknown>;

      expect(parsed).toEqual({
        correlation_id: '11111111-2222-4333-8444-555555555555',
        session_id: null,
        user_id: null,
        tenant_id: null,
        route: 'GET /health',
        http_status: 200,
        duration_ms: expect.any(Number),
      });
      done();
    });
  });

  it('carries user/tenant from request.user when present', (done) => {
    const interceptor = new LoggingInterceptor();
    const logSpy = jest.spyOn(interceptor['logger'], 'log');

    const { ctx } = makeContext({
      user: { userId: 'user-1', tenantId: 'tenant-1' },
      correlationId: '11111111-2222-4333-8444-555555555555',
    });
    const next = { handle: () => of('ok') };

    interceptor.intercept(ctx, next).subscribe(() => {
      const parsed = JSON.parse(
        (logSpy.mock.calls[0] as string[])[0],
      ) as Record<string, unknown>;
      expect(parsed.user_id).toBe('user-1');
      expect(parsed.tenant_id).toBe('tenant-1');
      done();
    });
  });

  it('reports the error status on a failed request', (done) => {
    const interceptor = new LoggingInterceptor();
    const logSpy = jest.spyOn(interceptor['logger'], 'log');

    const { ctx } = makeContext();
    const next = {
      handle: () => throwError(() => ({ status: 422 })),
    };

    interceptor.intercept(ctx, next).subscribe({
      error: () => {
        const parsed = JSON.parse(
          (logSpy.mock.calls[0] as string[])[0],
        ) as Record<string, unknown>;
        expect(parsed.http_status).toBe(422);
        done();
      },
    });
  });
});
