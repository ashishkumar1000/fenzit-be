import { ConsoleLogger, Logger } from '@nestjs/common';
import {
  CorrelationContext,
  runWithCorrelation,
} from './correlation.context';
import { CorrelationLogger, correlationLogFields } from './correlation-logger';

const CONTEXT: CorrelationContext = {
  correlationId: '11111111-2222-4333-8444-555555555555',
  sessionId: '9abcdef0-1234-4567-8abc-def012345678',
  userId: 'user-1',
  tenantId: 'tenant-1',
};

describe('CorrelationLogger', () => {
  let logger: CorrelationLogger;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    logger = new CorrelationLogger();
    logSpy = jest.spyOn(ConsoleLogger.prototype, 'log').mockImplementation(() => {});
    logSpy.mockClear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('merges context fields into a JSON-object message', () => {
    const message = JSON.stringify({ route: 'GET /health', http_status: 200 });

    runWithCorrelation(CONTEXT, () => logger.log(message));

    const arg = (logSpy.mock.calls[0] as unknown[])[0] as string;
    const parsed = JSON.parse(arg) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      route: 'GET /health',
      http_status: 200,
      correlation_id: CONTEXT.correlationId,
      session_id: CONTEXT.sessionId,
      user_id: CONTEXT.userId,
      tenant_id: CONTEXT.tenantId,
    });
  });

  it('appends a compact JSON suffix to a plain message', () => {
    runWithCorrelation(CONTEXT, () => logger.log('Processing report request'));

    const arg = (logSpy.mock.calls[0] as unknown[])[0] as string;
    expect(arg).toContain('Processing report request');
    expect(arg.endsWith(JSON.stringify(correlationLogFields(CONTEXT)))).toBe(true);
  });

  it('passes the message through untouched when there is no ALS store', () => {
    const message = 'plain boot line';

    logger.log(message);

    expect(logSpy.mock.calls[0][0]).toBe(message);
  });

  it('keeps the suffix form for a string that only looks like JSON', () => {
    runWithCorrelation(CONTEXT, () => logger.log('{not json'));

    const arg = (logSpy.mock.calls[0] as unknown[])[0] as string;
    expect(arg).toContain('{not json');
    expect(arg).toContain('correlation_id');
  });

  it('drops null fields (public route: no user, no session)', () => {
    const partial: CorrelationContext = {
      correlationId: CONTEXT.correlationId,
      sessionId: null,
      userId: null,
      tenantId: null,
    };

    expect(correlationLogFields(partial)).toEqual({
      correlation_id: CONTEXT.correlationId,
    });
  });
});

describe('correlationLogFields', () => {
  it('exposes exactly the non-null context fields', () => {
    expect(correlationLogFields(CONTEXT)).toEqual({
      correlation_id: CONTEXT.correlationId,
      session_id: CONTEXT.sessionId,
      user_id: CONTEXT.userId,
      tenant_id: CONTEXT.tenantId,
    });
  });
});

describe('CorrelationLogger wiring (the app.useLogger delegation)', () => {
  afterEach(() => {
    Logger.overrideLogger(false);
    jest.restoreAllMocks();
  });

  it('routes instance Loggers through the registered app logger, merge included', () => {
    // The same delegation `app.useLogger(...)` relies on in main.ts: an
    // instance `new Logger(Context)` must land in CorrelationLogger.log.
    Logger.overrideLogger(new CorrelationLogger());
    const spy = jest
      .spyOn(ConsoleLogger.prototype, 'log')
      .mockImplementation(() => {});

    runWithCorrelation(CONTEXT, () => new Logger('SomeService').log('doing work'));

    expect(spy).toHaveBeenCalledTimes(1);
    const arg = (spy.mock.calls[0] as unknown[])[0] as string;
    expect(arg).toContain('doing work');
    expect(arg).toContain('"correlation_id":"11111111-2222-4333-8444-555555555555"');
  });
});
