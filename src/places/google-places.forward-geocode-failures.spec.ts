import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { GooglePlacesProvider } from './google-places.provider';

const API_KEY = 'test-google-api-key';

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

const okBody = () => ({
  status: 'OK',
  results: [
    {
      formatted_address: 'MG Road, Bengaluru, Karnataka 560001, India',
      geometry: { location: { lat: 12.9759, lng: 77.6068 } },
    },
  ],
});

describe('GooglePlacesProvider.forwardGeocode failures and key secrecy (QA)', () => {
  let provider: GooglePlacesProvider;
  let fetchSpy: jest.SpyInstance;
  let installedFetchStub = false;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GooglePlacesProvider,
        {
          provide: ConfigService,
          useValue: { getOrThrow: jest.fn().mockReturnValue(API_KEY) },
        },
      ],
    }).compile();

    provider = module.get(GooglePlacesProvider);

    if (!global.fetch) {
      (global as { fetch?: unknown }).fetch = async () => {
        throw new Error('fetch stub: no test configured a response');
      };
      installedFetchStub = true;
    }
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    jest.restoreAllMocks();
    if (installedFetchStub) {
      delete (global as { fetch?: unknown }).fetch;
      installedFetchStub = false;
    }
  });

  describe('failure paths (must throw, never look like not-found)', () => {
    it('should throw on OVER_QUERY_LIMIT rather than reporting the address as not found', async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse(200, {
          status: 'OVER_QUERY_LIMIT',
          error_message: 'You have exceeded your daily request quota',
        }),
      );

      await expect(provider.forwardGeocode('MG Road')).rejects.toThrow(
        /OVER_QUERY_LIMIT/,
      );
    });

    it('should throw on UNKNOWN_ERROR rather than returning the null shape', async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse(200, { status: 'UNKNOWN_ERROR' }),
      );

      await expect(provider.forwardGeocode('MG Road')).rejects.toThrow(
        /UNKNOWN_ERROR/,
      );
    });

    it('should throw on REQUEST_DENIED and carry the provider error message', async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse(200, {
          status: 'REQUEST_DENIED',
          error_message: 'The provided API key is invalid.',
        }),
      );

      await expect(provider.forwardGeocode('MG Road')).rejects.toThrow(
        /REQUEST_DENIED.*The provided API key is invalid/,
      );
    });

    it('should throw when the body has no status field at all', async () => {
      fetchSpy.mockResolvedValue(jsonResponse(200, { results: [] }));

      await expect(provider.forwardGeocode('MG Road')).rejects.toThrow();
    });

    it.each([400, 403, 429, 500, 503])(
      'should throw on an HTTP %i response',
      async (status) => {
        fetchSpy.mockResolvedValue(jsonResponse(status, {}));

        await expect(provider.forwardGeocode('MG Road')).rejects.toThrow(
          new RegExp(`status ${status}`),
        );
      },
    );

    it('should let a network-level failure (fetch rejects) propagate as a throw', async () => {
      fetchSpy.mockRejectedValue(new TypeError('fetch failed'));

      await expect(provider.forwardGeocode('MG Road')).rejects.toThrow(
        'fetch failed',
      );
    });

    it('should let a timeout abort propagate as a throw', async () => {
      fetchSpy.mockRejectedValue(
        new DOMException('The operation was aborted', 'TimeoutError'),
      );

      await expect(provider.forwardGeocode('MG Road')).rejects.toThrow();
    });
  });

  describe('API key secrecy', () => {
    it('should never include the API key in any thrown message, across every failure path', async () => {
      const scenarios: Array<() => void> = [
        () =>
          fetchSpy.mockResolvedValue(
            jsonResponse(200, {
              status: 'REQUEST_DENIED',
              error_message: 'denied',
            }),
          ),
        () => fetchSpy.mockResolvedValue(jsonResponse(500, {})),
        () =>
          fetchSpy.mockResolvedValue(
            jsonResponse(200, { status: 'OVER_QUERY_LIMIT' }),
          ),
        () => fetchSpy.mockRejectedValue(new TypeError('fetch failed')),
      ];

      for (const arrange of scenarios) {
        fetchSpy.mockReset();
        arrange();
        let message = '';
        try {
          await provider.forwardGeocode('MG Road');
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message).not.toBe('');
        expect(message).not.toContain(API_KEY);
      }
    });

    it('should never write the API key to any logger during a successful or failing lookup', async () => {
      const errorSpy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation();
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();

      fetchSpy.mockResolvedValueOnce(jsonResponse(200, okBody()));
      await provider.forwardGeocode('MG Road');
      fetchSpy.mockResolvedValueOnce(jsonResponse(500, {}));
      await expect(provider.forwardGeocode('MG Road')).rejects.toThrow();

      const logged = [errorSpy, warnSpy, logSpy]
        .flatMap((spy) => spy.mock.calls)
        .map((args) => JSON.stringify(args))
        .join(' ');
      expect(logged).not.toContain(API_KEY);
    });
  });
});
