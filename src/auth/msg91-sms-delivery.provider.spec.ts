import { ConfigService } from '@nestjs/config';
import { Msg91SmsDeliveryProvider } from './msg91-sms-delivery.provider';
import { SmsDeliveryError } from './sms-delivery.provider';
import { SMS_TEMPLATES } from '../common/constants/sms-templates';

/**
 * All HTTP is mocked at the global fetch boundary — no real request leaves
 * the process, so no real SMS is ever spent in CI (PRD FR-T2). The wire
 * contract pinned here is the one that DELIVERS (live-verified 2026-10-15):
 * POST /api/v5/flow with named-variable recipients — the /otp endpoint
 * queues type:success but the message dies in DLT scrubbing for a
 * `##number##` template.
 */
describe('Msg91SmsDeliveryProvider', () => {
  let provider: Msg91SmsDeliveryProvider;
  let configService: jest.Mocked<Pick<ConfigService, 'get' | 'getOrThrow'>>;

  const fetchMock = jest.fn<Promise<Response>, [URL | string, RequestInit?]>();

  beforeAll(() => {
    // AbortSignal.timeout exists in the Node/Jest environment — pin it only
    // if missing (older jsdom), otherwise leave the real one alone.
    if (typeof AbortSignal.timeout !== 'function') {
      // @ts-expect-error test-env shim
      AbortSignal.timeout = (ms: number) => AbortSignal.abort();
    }
  });

  beforeEach(() => {
    configService = {
      get: jest.fn(),
      getOrThrow: jest.fn().mockReturnValue('test-auth-key'),
    };
    provider = new Msg91SmsDeliveryProvider(
      configService as unknown as ConfigService,
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockReset();
  });

  const okJson = (body: unknown) =>
    ({
      ok: true,
      status: 200,
      json: async () => body,
    }) as Response;

  it('POSTs the flow endpoint with template_id, digits-only mobiles, the variable mapped BY NAME, short_url off — authkey in the HEADER, not the body', async () => {
    fetchMock.mockResolvedValue(okJson({ type: 'success' }));

    await provider.send('+919876543210', SMS_TEMPLATES.OTP_LOGIN, {
      number: '1234',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://control.msg91.com/api/v5/flow/');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['authkey']).toBe(
      'test-auth-key',
    );

    const body = JSON.parse(String(init?.body));
    expect(body.template_id).toBe(SMS_TEMPLATES.OTP_LOGIN);
    expect(body.short_url).toBe(0);
    expect(body.recipients).toEqual([
      { mobiles: '919876543210', number: '1234' }, // no '+', variable named
    ]);
  });

  it('HTTP 200 with {"type":"success"} resolves', async () => {
    fetchMock.mockResolvedValue(okJson({ type: 'success' }));
    await expect(
      provider.send('+919876543210', SMS_TEMPLATES.OTP_LOGIN, {
        number: '1234',
      }),
    ).resolves.toBeUndefined();
  });

  it('HTTP 200 with {"type":"error"} (MSG91 answers 200 on DLT/template rejections) throws outcome "error" carrying the vendor type', async () => {
    fetchMock.mockResolvedValue(
      okJson({ type: 'error', message: 'Template not found' }),
    );

    const err = await provider
      .send('+919876543210', SMS_TEMPLATES.OTP_LOGIN, { number: '1234' })
      .catch((e: SmsDeliveryError) => e);

    expect(err).toBeInstanceOf(SmsDeliveryError);
    expect(err.outcome).toBe('error');
    expect(err.vendorType).toBe('error');
    expect(err.message).toContain('Template not found');
  });

  it('a non-2xx status throws outcome "error"', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 402,
      json: async () => ({ type: 'error' }),
    } as Response);

    const err = await provider
      .send('+919876543210', SMS_TEMPLATES.OTP_LOGIN, { number: '1234' })
      .catch((e: SmsDeliveryError) => e);

    expect(err).toBeInstanceOf(SmsDeliveryError);
    expect(err.outcome).toBe('error');
    expect(err.message).toContain('402');
  });

  it('a non-JSON body counts as a failure (type "none"), not a crash', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('Unexpected token < in JSON');
      },
    } as unknown as Response);

    const err = await provider
      .send('+919876543210', SMS_TEMPLATES.OTP_LOGIN, { number: '1234' })
      .catch((e: SmsDeliveryError) => e);

    expect(err).toBeInstanceOf(SmsDeliveryError);
    expect(err.outcome).toBe('error');
    expect(err.vendorType).toBeUndefined();
  });

  it('a timeout-shaped rejection (TimeoutError) maps to outcome "timeout" — the caller must keep the session', async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError',
      }),
    );

    const err = await provider
      .send('+919876543210', SMS_TEMPLATES.OTP_LOGIN, { number: '1234' })
      .catch((e: SmsDeliveryError) => e);

    expect(err).toBeInstanceOf(SmsDeliveryError);
    expect(err.outcome).toBe('timeout');
  });

  it('a generic AbortError (some runtimes name it so) also maps to outcome "timeout"', async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new Error('This operation was aborted'), {
        name: 'AbortError',
      }),
    );

    const err = await provider
      .send('+919876543210', SMS_TEMPLATES.OTP_LOGIN, { number: '1234' })
      .catch((e: SmsDeliveryError) => e);

    expect(err).toBeInstanceOf(SmsDeliveryError);
    expect(err.outcome).toBe('timeout');
  });

  it('a timeout during the BODY read (headers already arrived) maps to "timeout", not a definitive error', async () => {
    // MSG91 accepted the request — the SMS may still dispatch — so this must
    // land in the same keep-the-session outcome as a fetch-phase timeout.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw Object.assign(new Error('The operation was aborted due to timeout'), {
          name: 'TimeoutError',
        });
      },
    } as unknown as Response);

    const err = await provider
      .send('+919876543210', SMS_TEMPLATES.OTP_LOGIN, { number: '1234' })
      .catch((e: SmsDeliveryError) => e);

    expect(err).toBeInstanceOf(SmsDeliveryError);
    expect(err.outcome).toBe('timeout');
  });

  it('a missing MSG91_AUTH_KEY surfaces as the boot/config error it is — NOT a folded SmsDeliveryError', async () => {
    configService.getOrThrow.mockImplementation(() => {
      throw new Error('MSG91_AUTH_KEY is not set');
    });

    await expect(
      provider.send('+919876543210', SMS_TEMPLATES.OTP_LOGIN, {
        number: '1234',
      }),
    ).rejects.toThrow('MSG91_AUTH_KEY is not set');
    // Never dispatched — the authkey is read before fetch.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a connection-level failure (DNS, refused) maps to outcome "error"', async () => {
    fetchMock.mockRejectedValue(
      new Error('getaddrinfo ENOTFOUND control.msg91.com'),
    );

    const err = await provider
      .send('+919876543210', SMS_TEMPLATES.OTP_LOGIN, { number: '1234' })
      .catch((e: SmsDeliveryError) => e);

    expect(err).toBeInstanceOf(SmsDeliveryError);
    expect(err.outcome).toBe('error');
  });
});
