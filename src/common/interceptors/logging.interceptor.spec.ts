import { ExecutionContext } from '@nestjs/common';
import { of } from 'rxjs';
import { LoggingInterceptor } from './logging.interceptor';

const makeContext = () => {
  const request = {
    method: 'GET',
    url: '/health',
    headers: {},
    user: null,
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
  it('adds requestId to request and logs structured JSON', (done) => {
    const interceptor = new LoggingInterceptor();
    const logSpy = jest.spyOn(interceptor['logger'], 'log');

    const { ctx, request } = makeContext();
    const next = { handle: () => of('ok') };

    interceptor.intercept(ctx, next).subscribe(() => {
      expect((request as { requestId?: string }).requestId).toBeDefined();
      expect(logSpy).toHaveBeenCalledTimes(1);

      const logArg = (logSpy.mock.calls[0] as string[])[0];
      const parsed = JSON.parse(logArg) as Record<string, unknown>;

      expect(parsed).toHaveProperty('request_id');
      expect(parsed).toHaveProperty('tenant_id');
      expect(parsed).toHaveProperty('route');
      expect(parsed).toHaveProperty('http_status');
      expect(parsed).toHaveProperty('duration_ms');
      done();
    });
  });
});
