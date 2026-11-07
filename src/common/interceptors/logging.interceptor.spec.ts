import { ExecutionContext } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { LoggingInterceptor, redactRouteSecrets } from './logging.interceptor';

const makeContext = (
  extras: {
    user?: unknown;
    correlationId?: string;
    sessionId?: string | null;
    headers?: Record<string, string>;
  } = {},
) => {
  const request = {
    method: 'GET',
    url: '/health',
    headers: extras.headers ?? {},
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
        app_version: null,
        platform: null,
        os_version: null,
        device_model: null,
      });
      done();
    });
  });

  it('logs the client metadata headers when the app sends them', (done) => {
    const interceptor = new LoggingInterceptor();
    const logSpy = jest.spyOn(interceptor['logger'], 'log');

    const { ctx } = makeContext({
      headers: {
        'x-app-version': '1.0.0',
        'x-platform': 'android',
        'x-os-version': '34',
        'x-device-model': 'Pixel 6',
      },
    });
    const next = { handle: () => of('ok') };

    interceptor.intercept(ctx, next).subscribe(() => {
      const parsed = JSON.parse(
        (logSpy.mock.calls[0] as string[])[0],
      ) as Record<string, unknown>;
      expect(parsed.app_version).toBe('1.0.0');
      expect(parsed.platform).toBe('android');
      expect(parsed.os_version).toBe('34');
      expect(parsed.device_model).toBe('Pixel 6');
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

describe('redactRouteSecrets', () => {
  it('replaces a device token in the DELETE path with a placeholder', () => {
    expect(redactRouteSecrets('/api/v1/device-tokens/abc123secret')).toBe(
      '/api/v1/device-tokens/:token',
    );
  });

  it('handles the path without the api prefix', () => {
    expect(redactRouteSecrets('/device-tokens/abc123secret')).toBe(
      '/device-tokens/:token',
    );
  });

  it('drops the query string on every route (a future query secret cannot leak)', () => {
    expect(redactRouteSecrets('/api/v1/jobs/123?token=secret&x=1')).toBe(
      '/api/v1/jobs/123',
    );
  });

  it('redacts an encoded token that contains an escaped slash', () => {
    expect(redactRouteSecrets('/api/v1/device-tokens/a%2Fb%2Fc')).toBe(
      '/api/v1/device-tokens/:token',
    );
  });

  it('leaves the list route untouched (no token segment to redact)', () => {
    expect(redactRouteSecrets('/api/v1/device-tokens')).toBe(
      '/api/v1/device-tokens',
    );
  });

  it('does not invent a placeholder for an empty trailing segment', () => {
    expect(redactRouteSecrets('/api/v1/device-tokens/')).toBe(
      '/api/v1/device-tokens/',
    );
  });

  it('leaves unrelated routes with the same word in the middle untouched', () => {
    expect(redactRouteSecrets('/api/v1/jobs/device-tokens-report')).toBe(
      '/api/v1/jobs/device-tokens-report',
    );
  });

  it('keeps a trailing path after the token, redacting only the token segment', () => {
    expect(redactRouteSecrets('/api/v1/device-tokens/secret/extra')).toBe(
      '/api/v1/device-tokens/:token/extra',
    );
  });
});
