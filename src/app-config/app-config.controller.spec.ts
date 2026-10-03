import { AppConfigController } from './app-config.controller';
import type { AppConfigService } from './app-config.service';

describe('AppConfigController', () => {
  const payload = {
    config: { min_supported_version: '1.0.0', api_timeout_ms: 30000 },
    configVersion: '2026-10-03T12:00:00.000Z',
  };

  const makeController = () => {
    const service = {
      getAppConfig: jest.fn(async () => ({ payload, etag: '"abc123"' })),
    };
    return {
      controller: new AppConfigController(service as unknown as AppConfigService),
      service,
    };
  };

  it('returns the payload and sets shared-cache headers', async () => {
    const { controller } = makeController();
    const header = jest.fn();
    const reply = { header };

    await expect(controller.getApp(reply as never)).resolves.toBe(payload);

    expect(header).toHaveBeenCalledWith('etag', '"abc123"');
    expect(header).toHaveBeenCalledWith('cache-control', 'public, max-age=60');
  });

  it('reads through the service every call (caching is the service+edge job)', async () => {
    const { controller, service } = makeController();
    const reply = { header: jest.fn() };

    await controller.getApp(reply as never);
    await controller.getApp(reply as never);

    expect(service.getAppConfig).toHaveBeenCalledTimes(2);
  });
});
