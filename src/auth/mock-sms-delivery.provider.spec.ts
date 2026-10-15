import { Logger } from '@nestjs/common';
import { MockSmsDeliveryProvider } from './mock-sms-delivery.provider';

/**
 * The mock's log line IS its delivery: wherever the mock is the active
 * provider (dev/test, and the pre-SMS-cutover production window per
 * render.yaml), an internal tester reads the code from this line. A refactor
 * that breaks it — wrong variable slot, dropped "Code:" marker — would
 * silently kill the only delivery channel while every suite stays green
 * (the service spec swaps the port for a jest.fn(); the e2e specs read the
 * OTP_DEV_ECHO response field, never the logs). So the exact contract is
 * pinned here.
 */
describe('MockSmsDeliveryProvider', () => {
  let provider: MockSmsDeliveryProvider;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    provider = new MockSmsDeliveryProvider();
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('logs the code under a greppable "Code:" marker with the recipient phone', async () => {
    await provider.send('+919876543210', 'tpl-id', { number: '1295' });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = String(logSpy.mock.calls[0][0]);
    expect(line).toContain('[MOCK SMS]');
    expect(line).toContain('Phone: +919876543210');
    expect(line).toContain('Code: 1295');
    expect(line).toContain('tpl-id');
  });

  it('picks the code from the named ##number## slot, not positionally', async () => {
    // If the OTP template ever gains a second variable, the FIRST object
    // value must not be mislabeled as the code.
    await provider.send('+919876543210', 'tpl-id', {
      number: '1295',
      futurevar: 'zzz',
    });

    const line = String(logSpy.mock.calls[0][0]);
    expect(line).toContain('Code: 1295');
  });

  it('falls back to the first value for a template with no ##number## slot, and "(none)" when empty', async () => {
    await provider.send('+919876543210', 'tpl-id', { body: 'hello' });
    expect(String(logSpy.mock.calls[0][0])).toContain('Code: hello');

    await provider.send('+919876543210', 'tpl-id', {});
    expect(String(logSpy.mock.calls[1][0])).toContain('Code: (none)');
  });
});
