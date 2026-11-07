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

const okBody = (overrides: Record<string, unknown> = {}) => ({
  status: 'OK',
  results: [
    {
      formatted_address: 'MG Road, Bengaluru, Karnataka 560001, India',
      geometry: { location: { lat: 12.9759, lng: 77.6068 } },
      ...overrides,
    },
  ],
});

const nullShape = {
  formattedAddress: null,
  latitude: null,
  longitude: null,
  approximate: false,
  city: null,
  state: null,
  pincode: null,
};

describe('GooglePlacesProvider.forwardGeocode (QA)', () => {
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

  /** Parses the URL the provider actually requested. */
  function requestedUrl(callIndex = 0): URL {
    return new URL(String(fetchSpy.mock.calls[callIndex][0]));
  }

  describe('request shape', () => {
    it('should call the legacy Geocoding endpoint with the typed address and country restricted to India', async () => {
      fetchSpy.mockResolvedValue(jsonResponse(200, okBody()));

      await provider.forwardGeocode('MG Road, Bengaluru');

      const url = requestedUrl();
      expect(url.origin + url.pathname).toBe(
        'https://maps.googleapis.com/maps/api/geocode/json',
      );
      expect(url.searchParams.get('address')).toBe('MG Road, Bengaluru');
      expect(url.searchParams.get('components')).toBe('country:IN');
    });

    it('should put the API key in the query string and never in a request header', async () => {
      fetchSpy.mockResolvedValue(jsonResponse(200, okBody()));

      await provider.forwardGeocode('MG Road, Bengaluru');

      const url = requestedUrl();
      expect(url.searchParams.get('key')).toBe(API_KEY);
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      expect(init.method).toBe('GET');
      expect(JSON.stringify(init.headers ?? {})).not.toContain(API_KEY);
      expect(init.headers).toBeUndefined();
    });

    it('should send an address containing URL metacharacters byte-for-byte, not split or truncated', async () => {
      fetchSpy.mockResolvedValue(jsonResponse(200, okBody()));
      const hostile = 'Flat 4&5 #12, Road+Lane "A" / B=C?x=1';

      await provider.forwardGeocode(hostile);

      expect(requestedUrl().searchParams.get('address')).toBe(hostile);
      // The injected `x=1` must not become a real query parameter.
      expect(requestedUrl().searchParams.has('x')).toBe(false);
    });

    it('should send a SQL-looking address as an opaque string without altering it', async () => {
      fetchSpy.mockResolvedValue(jsonResponse(200, okBody()));
      const sqlish = "'; DROP TABLE addresses; --";

      await provider.forwardGeocode(sqlish);

      expect(requestedUrl().searchParams.get('address')).toBe(sqlish);
    });

    it('should send a non-Latin (Devanagari) address intact', async () => {
      fetchSpy.mockResolvedValue(jsonResponse(200, okBody()));
      const hindiAddress = 'मुंबई, महाराष्ट्र';

      await provider.forwardGeocode(hindiAddress);

      expect(requestedUrl().searchParams.get('address')).toBe(hindiAddress);
    });
  });

  describe('successful lookups', () => {
    it('should return coordinates and the formatted address for a single OK result', async () => {
      fetchSpy.mockResolvedValue(jsonResponse(200, okBody()));

      await expect(provider.forwardGeocode('MG Road')).resolves.toEqual({
        formattedAddress: 'MG Road, Bengaluru, Karnataka 560001, India',
        latitude: 12.9759,
        longitude: 77.6068,
        approximate: false,
        city: null,
        state: null,
        pincode: null,
      });
    });

    it('should accept exactly 0 for latitude and longitude as real coordinates, not as "not found"', async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse(
          200,
          okBody({ geometry: { location: { lat: 0, lng: 0 } } }),
        ),
      );

      await expect(provider.forwardGeocode('Null Island')).resolves.toEqual({
        formattedAddress: 'MG Road, Bengaluru, Karnataka 560001, India',
        latitude: 0,
        longitude: 0,
        approximate: false,
        city: null,
        state: null,
        pincode: null,
      });
    });

    it('should keep negative coordinates (southern and western hemispheres) as negative numbers', async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse(
          200,
          okBody({ geometry: { location: { lat: -33.8688, lng: -151.2093 } } }),
        ),
      );

      const result = await provider.forwardGeocode('Sydney');

      expect(result.latitude).toBe(-33.8688);
      expect(result.longitude).toBe(-151.2093);
    });

    it('should normalize an empty formatted_address to null, never ""', async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse(200, okBody({ formatted_address: '' })),
      );

      const result = await provider.forwardGeocode('MG Road');

      expect(result.formattedAddress).toBeNull();
      expect(result.latitude).toBe(12.9759);
    });

    it('should use the first result when Google returns several matches', async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse(200, {
          status: 'OK',
          results: [
            {
              formatted_address: 'First',
              geometry: { location: { lat: 1, lng: 2 } },
            },
            {
              formatted_address: 'Second',
              geometry: { location: { lat: 3, lng: 4 } },
            },
          ],
        }),
      );

      await expect(provider.forwardGeocode('Ambiguous')).resolves.toEqual({
        formattedAddress: 'First',
        latitude: 1,
        longitude: 2,
        approximate: false,
        city: null,
        state: null,
        pincode: null,
      });
    });
  });

  describe('not-found shapes (success, never a throw)', () => {
    it('should return the null shape on ZERO_RESULTS', async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse(200, { status: 'ZERO_RESULTS', results: [] }),
      );

      await expect(provider.forwardGeocode('nowhere-xyz')).resolves.toEqual(
        nullShape,
      );
    });

    it('should return the null shape when status is OK but results is an empty array', async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse(200, { status: 'OK', results: [] }),
      );

      await expect(provider.forwardGeocode('edge')).resolves.toEqual(nullShape);
    });

    it('should return the null shape when status is OK but results is missing entirely', async () => {
      fetchSpy.mockResolvedValue(jsonResponse(200, { status: 'OK' }));

      await expect(provider.forwardGeocode('edge')).resolves.toEqual(nullShape);
    });

    it('should return the null shape when the first result has no geometry', async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse(200, {
          status: 'OK',
          results: [{ formatted_address: 'Somewhere' }],
        }),
      );

      await expect(provider.forwardGeocode('Somewhere')).resolves.toEqual(
        nullShape,
      );
    });

    it('should return the null shape when the location has latitude but no longitude', async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse(200, okBody({ geometry: { location: { lat: 12.9 } } })),
      );

      await expect(provider.forwardGeocode('half')).resolves.toEqual(nullShape);
    });
  });
});
