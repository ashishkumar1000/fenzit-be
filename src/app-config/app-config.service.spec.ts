import { AppConfigService } from './app-config.service';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';

const ROWS = [
  {
    key: 'min_supported_version',
    value: '1.0.0',
    updated_at: '2026-10-03T10:00:00.000Z',
  },
  {
    key: 'api_timeout_ms',
    value: 30000,
    updated_at: '2026-10-03T12:00:00.000Z',
  },
];

describe('AppConfigService', () => {
  const select = jest.fn();
  const from = jest.fn(() => ({ select }));
  const builder = {
    on: jest.fn(),
    subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })),
  };
  builder.on.mockImplementation(() => builder);
  const channel = jest.fn(() => builder);
  const removeChannel = jest.fn(async () => undefined);
  const admin = { from, channel, removeChannel };
  const factory = {
    createAdmin: jest.fn(() => admin),
  } as unknown as SupabaseClientFactory;

  beforeEach(() => {
    jest.clearAllMocks();
    builder.on.mockImplementation(() => builder);
    select.mockResolvedValue({ data: ROWS, error: null });
  });

  const newService = () => new AppConfigService(factory);

  it('subscribes to app_config changes on init', () => {
    const service = newService();
    service.onModuleInit();

    expect(channel).toHaveBeenCalledWith('app_config_changes');
    const [event, filter] = builder.on.mock.calls[0];
    expect(event).toBe('postgres_changes');
    expect(filter).toEqual({ event: '*', schema: 'public', table: 'app_config' });
  });

  it('returns the flat config map with the newest updated_at as configVersion', async () => {
    const { payload, etag } = await newService().getAppConfig();

    expect(payload.config).toEqual({
      min_supported_version: '1.0.0',
      api_timeout_ms: 30000,
    });
    expect(payload.configVersion).toBe('2026-10-03T12:00:00.000Z');
    expect(etag).toMatch(/^"[0-9a-f]{40}"$/);
  });

  it('serves repeat reads from memory within the TTL', async () => {
    const service = newService();
    await service.getAppConfig();
    await service.getAppConfig();

    expect(from).toHaveBeenCalledTimes(1);
  });

  it('refetches after the TTL expires', async () => {
    jest.useFakeTimers();
    try {
      const service = newService();
      await service.getAppConfig();
      jest.setSystemTime(Date.now() + 61_000);
      await service.getAppConfig();

      expect(from).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('a realtime change event invalidates the cache immediately', async () => {
    const service = newService();
    service.onModuleInit();
    await service.getAppConfig();

    const changeCall = builder.on.mock.calls.find(
      ([event]) => event === 'postgres_changes',
    );
    changeCall?.[2]();

    await service.getAppConfig();
    expect(from).toHaveBeenCalledTimes(2);
  });

  it('maps a DB error to a 500 with the internal error code', async () => {
    select.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });

    await expect(newService().getAppConfig()).rejects.toMatchObject({
      status: 500,
    });
  });

  it('onModuleDestroy removes the realtime channel', async () => {
    const service = newService();
    service.onModuleInit();
    await service.onModuleDestroy();

    expect(removeChannel).toHaveBeenCalledTimes(1);
  });

  it('shutdown without an init-ed channel is a no-op', async () => {
    await expect(newService().onModuleDestroy()).resolves.toBeUndefined();
    expect(removeChannel).not.toHaveBeenCalled();
  });

  it('a failed realtime subscription does not break init', () => {
    channel.mockImplementationOnce(() => {
      throw new Error('no socket');
    });

    expect(() => newService().onModuleInit()).not.toThrow();
  });
});
