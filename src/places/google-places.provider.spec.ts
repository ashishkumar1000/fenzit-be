import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { GooglePlacesProvider } from './google-places.provider';

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

/** Typed accessor for a `jest.spyOn(global, 'fetch')` call's arguments,
 * avoiding `@typescript-eslint/no-unsafe-assignment` on the untyped mock
 * call tuple. */
function fetchCallArgs(
  fetchSpy: jest.SpyInstance,
  callIndex = 0,
): [url: string | URL, init: RequestInit] {
  const [url, init] = fetchSpy.mock.calls[callIndex] as [
    string | URL,
    RequestInit,
  ];
  return [url, init];
}

describe('GooglePlacesProvider', () => {
  let provider: GooglePlacesProvider;
  let fetchSpy: jest.SpyInstance;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GooglePlacesProvider,
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn().mockReturnValue('test-google-api-key'),
          },
        },
      ],
    }).compile();

    provider = module.get(GooglePlacesProvider);
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('should return normalized suggestions for a successful Google autocomplete response', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, {
        suggestions: [
          {
            placePrediction: {
              placeId: 'ChIJ-google-1',
              text: { text: '123 Main St, Mumbai, Maharashtra, India' },
              structuredFormat: {
                mainText: { text: '123 Main St' },
                secondaryText: { text: 'Mumbai, Maharashtra, India' },
              },
            },
          },
        ],
      }),
    );

    const suggestions = await provider.autosuggest(
      '123 main',
      'session-1',
      'IN',
    );

    expect(suggestions).toEqual([
      {
        placeId: 'ChIJ-google-1',
        text: '123 Main St, Mumbai, Maharashtra, India',
      },
    ]);
  });

  it('should send the API key only via the X-Goog-Api-Key header, never in the query string or body', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, { suggestions: [] }));

    await provider.autosuggest('123 main', 'session-1', 'IN');

    const [url, init] = fetchCallArgs(fetchSpy);
    expect(String(url)).not.toContain('test-google-api-key');
    expect(init.headers).toMatchObject({
      'X-Goog-Api-Key': 'test-google-api-key',
    });
    expect(init.body as string).not.toContain('test-google-api-key');
  });

  it('should send includedRegionCodes and the caller sessionToken on autosuggest', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, { suggestions: [] }));

    await provider.autosuggest('andheri', 'session-abc', 'IN');

    const [, init] = fetchCallArgs(fetchSpy);
    const body: unknown = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      input: 'andheri',
      sessionToken: 'session-abc',
      includedRegionCodes: ['IN'],
    });
  });

  it('should throw when the Google autocomplete request returns a non-2xx status', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(500, {}));

    await expect(
      provider.autosuggest('andheri', 'session-1', 'IN'),
    ).rejects.toThrow();
  });

  it('should silently drop malformed suggestions[] entries and keep well-formed ones', async () => {
    // Pinned (not "fixed") behaviour per the provider spec: a malformed entry
    // is dropped rather than surfaced as an error — a single bad suggestion
    // from Google must not fail the whole typeahead call.
    fetchSpy.mockResolvedValue(
      jsonResponse(200, {
        suggestions: [
          { placePrediction: null }, // no placePrediction at all
          { unexpectedShape: true }, // no placePrediction key
          { placePrediction: { text: { text: 'no placeId' } } }, // placeId missing
          { placePrediction: { placeId: 'ChIJ-no-text' } }, // text missing
          {
            placePrediction: {
              placeId: 'ChIJ-google-1',
              text: { text: '123 Main St, Mumbai, Maharashtra, India' },
            },
          },
        ],
      }),
    );

    const suggestions = await provider.autosuggest(
      '123 main',
      'session-1',
      'IN',
    );

    expect(suggestions).toEqual([
      {
        placeId: 'ChIJ-google-1',
        text: '123 Main St, Mumbai, Maharashtra, India',
      },
    ]);
  });

  it('should throw when the Google autocomplete request times out/aborts', async () => {
    fetchSpy.mockRejectedValue(
      new DOMException('The signal timed out', 'TimeoutError'),
    );

    await expect(
      provider.autosuggest('andheri', 'session-1', 'IN'),
    ).rejects.toThrow();
  });

  describe('resolve', () => {
    it('should return a ResolvedPlace when Google returns location, postalAddress and a locality component', async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse(200, {
          id: 'ChIJ-google-1',
          formattedAddress: '123 Main St, Mumbai, Maharashtra 400058, India',
          location: { latitude: 19.1364, longitude: 72.8296 },
          postalAddress: { postalCode: '400058', regionCode: 'IN' },
          addressComponents: [
            { longText: 'Mumbai', shortText: 'Mumbai', types: ['locality'] },
            {
              longText: 'Andheri West',
              shortText: 'Andheri West',
              types: ['sublocality_level_1'],
            },
          ],
        }),
      );

      const resolved = await provider.resolve(
        'ChIJ-google-1',
        'session-1',
        'IN',
      );

      expect(resolved).toEqual({
        placeId: 'ChIJ-google-1',
        formattedAddress: '123 Main St, Mumbai, Maharashtra 400058, India',
        city: 'Mumbai',
        pincode: '400058',
        latitude: 19.1364,
        longitude: 72.8296,
      });
    });

    it('should send the field mask header restricted to Essentials-tier fields', async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse(200, {
          id: 'ChIJ-google-1',
          formattedAddress: 'x',
          location: { latitude: 1, longitude: 2 },
        }),
      );

      await provider.resolve('ChIJ-google-1', 'session-1', 'IN');

      const [, init] = fetchCallArgs(fetchSpy);
      expect(init.headers).toMatchObject({
        'X-Goog-FieldMask':
          'id,formattedAddress,location,addressComponents,postalAddress',
      });
    });

    it('should return pincode: null when postalAddress is entirely absent from the response', async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse(200, {
          id: 'ChIJ-sublocality',
          formattedAddress: 'Koramangala, Bengaluru, Karnataka, India',
          location: { latitude: 12.9352, longitude: 77.6245 },
          addressComponents: [
            {
              longText: 'Bengaluru',
              shortText: 'Bengaluru',
              types: ['locality'],
            },
          ],
        }),
      );

      const resolved = await provider.resolve(
        'ChIJ-sublocality',
        'session-1',
        'IN',
      );

      expect(resolved.pincode).toBeNull();
      expect(resolved.city).toBe('Bengaluru');
    });

    it('should normalize an empty-string postalCode/locality to null, never returning ""', async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse(200, {
          id: 'ChIJ-empty-strings',
          formattedAddress: 'Somewhere, India',
          location: { latitude: 1, longitude: 2 },
          postalAddress: { postalCode: '' },
          addressComponents: [
            { longText: '', shortText: '', types: ['locality'] },
          ],
        }),
      );

      const resolved = await provider.resolve(
        'ChIJ-empty-strings',
        'session-1',
        'IN',
      );

      expect(resolved.pincode).toBeNull();
      expect(resolved.city).toBeNull();
    });

    it('should return city: null when no addressComponents entry is typed locality', async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse(200, {
          id: 'ChIJ-no-locality',
          formattedAddress: 'Some Region, India',
          location: { latitude: 1, longitude: 2 },
          addressComponents: [
            { longText: 'Region', shortText: 'Region', types: ['region'] },
          ],
        }),
      );

      const resolved = await provider.resolve(
        'ChIJ-no-locality',
        'session-1',
        'IN',
      );

      expect(resolved.city).toBeNull();
    });

    it('should take the FIRST locality component when Google returns several', async () => {
      // Pinned (not "fixed") behaviour per the provider spec: `.find()` wins
      // with the first locality entry; no error is raised for the ambiguity.
      fetchSpy.mockResolvedValue(
        jsonResponse(200, {
          id: 'ChIJ-two-localities',
          formattedAddress: 'Somewhere, India',
          location: { latitude: 1, longitude: 2 },
          addressComponents: [
            {
              longText: 'Bengaluru',
              shortText: 'Bengaluru',
              types: ['locality'],
            },
            { longText: 'Mumbai', shortText: 'Mumbai', types: ['locality'] },
          ],
        }),
      );

      const resolved = await provider.resolve(
        'ChIJ-two-localities',
        'session-1',
        'IN',
      );

      expect(resolved.city).toBe('Bengaluru');
    });

    it('should throw when Google returns a valid place with location absent (never a null-coordinate success)', async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse(200, {
          id: 'ChIJ-no-location',
          formattedAddress: 'Somewhere, India',
          addressComponents: [],
        }),
      );

      await expect(
        provider.resolve('ChIJ-no-location', 'session-1', 'IN'),
      ).rejects.toThrow();
    });

    it('should throw when the Google details request returns a non-2xx status', async () => {
      fetchSpy.mockResolvedValue(jsonResponse(404, {}));

      await expect(
        provider.resolve('ChIJ-missing', 'session-1', 'IN'),
      ).rejects.toThrow();
    });

    it('should throw when the Google details request times out/aborts', async () => {
      fetchSpy.mockRejectedValue(
        new DOMException('The signal timed out', 'TimeoutError'),
      );

      await expect(
        provider.resolve('ChIJ-timeout', 'session-1', 'IN'),
      ).rejects.toThrow();
    });
  });
});
