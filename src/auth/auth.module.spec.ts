import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import {
  createSmsDeliveryProvider,
  AuthModule,
} from './auth.module';
import { SmsDeliveryProvider } from './sms-delivery.provider';
import { MockSmsDeliveryProvider } from './mock-sms-delivery.provider';
import { Msg91SmsDeliveryProvider } from './msg91-sms-delivery.provider';

/**
 * Selection logic only (the exported factory, places-module style) — the
 * full Nest wiring boots in the e2e suites.
 */
describe('createSmsDeliveryProvider', () => {
  const baseConfig = (vars: Record<string, string | undefined>) =>
    ({
      get: (key: string) => vars[key],
    }) as unknown as ConfigService;

  afterEach(() => {
    // The factory reads NODE_ENV straight off process.env — restore whatever
    // Jest set so the suite never leaks selection state.
    process.env['NODE_ENV'] = 'test';
    delete process.env['SMS_DELIVERY_PROVIDER'];
  });

  it('NODE_ENV=test ALWAYS resolves the mock — CI must never burn real SMS', () => {
    process.env['SMS_DELIVERY_PROVIDER'] = 'msg91';
    const provider = createSmsDeliveryProvider(
      baseConfig({ SMS_DELIVERY_PROVIDER: 'msg91', MSG91_AUTH_KEY: 'k' }),
    );
    expect(provider).toBeInstanceOf(MockSmsDeliveryProvider);
  });

  it('an explicit SMS_DELIVERY_PROVIDER=mock wins over production\'s msg91 default (the PRD §9 step-1 landing state)', () => {
    process.env['NODE_ENV'] = 'production';
    const provider = createSmsDeliveryProvider(
      baseConfig({ SMS_DELIVERY_PROVIDER: 'mock' }),
    );
    expect(provider).toBeInstanceOf(MockSmsDeliveryProvider);
  });

  it('an explicit SMS_DELIVERY_PROVIDER=msg91 (with the auth key) resolves the MSG91 adapter', () => {
    process.env['NODE_ENV'] = 'production';
    const provider = createSmsDeliveryProvider(
      baseConfig({ SMS_DELIVERY_PROVIDER: 'msg91', MSG91_AUTH_KEY: 'k' }),
    );
    expect(provider).toBeInstanceOf(Msg91SmsDeliveryProvider);
  });

  it('development defaults to the mock (no env vars at all)', () => {
    process.env['NODE_ENV'] = 'development';
    const provider = createSmsDeliveryProvider(baseConfig({}));
    expect(provider).toBeInstanceOf(MockSmsDeliveryProvider);
  });

  it('production FORGETTING SMS_DELIVERY_PROVIDER defaults to msg91 and REFUSES TO BOOT without MSG91_AUTH_KEY (bad config = boot error, not a runtime login outage)', () => {
    process.env['NODE_ENV'] = 'production';
    expect(() => createSmsDeliveryProvider(baseConfig({}))).toThrow(
      /MSG91_AUTH_KEY/,
    );
  });

  it('an unknown provider name throws at the composition root', () => {
    process.env['NODE_ENV'] = 'development';
    expect(() =>
      createSmsDeliveryProvider(
        baseConfig({ SMS_DELIVERY_PROVIDER: 'smoke-signals' }),
      ),
    ).toThrow(/Unknown SMS_DELIVERY_PROVIDER/);
  });

  it('the Nest module registers the port behind the factory', () => {
    // Sanity: the provider token is bound via useFactory, so swapping
    // adapters never touches consumers.
    const providers = Reflect.getMetadata('providers', AuthModule) ?? [];
    const smsBinding = (providers as Array<Record<string, unknown>>).find(
      (p) => p['provide'] === SmsDeliveryProvider,
    );
    expect(smsBinding).toBeDefined();
    expect(typeof smsBinding?.['useFactory']).toBe('function');
  });
});
