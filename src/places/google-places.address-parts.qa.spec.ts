import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { GooglePlacesProvider } from './google-places.provider';

/**
 * QA for the forward lookup's address parts and approximate flag. Google's
 * legacy components: locality = city, administrative_area_level_1 = state,
 * postal_code = PIN. An area-centre match is kept and flagged; a partial
 * match is still refused.
 */
const API_KEY = 'test-google-api-key';

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as Response;
}

const component = (long_name: string, types: string[]) => ({
  long_name,
  types,
});

function resultWith(overrides: Record<string, unknown> = {}) {
  return {
    status: 'OK',
    results: [
      {
        formatted_address: 'Madhepur, Bihar 847408, India',
        geometry: {
          location: { lat: 26.1755791, lng: 86.38009559999999 },
          location_type: 'APPROXIMATE',
        },
        address_components: [
          component('Madhepur', ['locality', 'political']),
          component('Bihar', ['administrative_area_level_1', 'political']),
          component('847408', ['postal_code']),
          component('India', ['country', 'political']),
        ],
        ...overrides,
      },
    ],
  };
}

describe('GooglePlacesProvider.forwardGeocode address parts (QA)', () => {
  let provider: GooglePlacesProvider;
  let fetchSpy: jest.SpyInstance;

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
      (global as { fetch?: unknown }).fetch = () =>
        Promise.reject(new Error('fetch stub: no test configured a response'));
    }
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    jest.restoreAllMocks();
  });

  it('returns city, state and PIN from the matching components', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(resultWith()));
    const place = await provider.forwardGeocode('MADHEPUR, Bihar');
    expect(place).toMatchObject({
      city: 'Madhepur',
      state: 'Bihar',
      pincode: '847408',
    });
  });

  it('returns null for a part Google does not give, not an empty string', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(
        resultWith({
          address_components: [
            component('Bihar', ['administrative_area_level_1']),
          ],
        }),
      ),
    );
    const place = await provider.forwardGeocode('MADHEPUR, Bihar');
    expect(place.city).toBeNull();
    expect(place.pincode).toBeNull();
    expect(place.state).toBe('Bihar');
  });

  it('treats an empty component name as missing', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(
        resultWith({
          address_components: [
            component('', ['locality']),
            component('', ['postal_code']),
          ],
        }),
      ),
    );
    const place = await provider.forwardGeocode('MADHEPUR, Bihar');
    expect(place.city).toBeNull();
    expect(place.pincode).toBeNull();
  });

  it('keeps an area-centre match and flags it approximate', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(resultWith()));
    const place = await provider.forwardGeocode('MADHEPUR, Bihar');
    expect(place.approximate).toBe(true);
    expect(place.latitude).toBe(26.1755791);
  });

  it('marks a rooftop match as not approximate', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(
        resultWith({
          geometry: {
            location: { lat: 12.9759, lng: 77.6068 },
            location_type: 'ROOFTOP',
          },
        }),
      ),
    );
    const place = await provider.forwardGeocode('MG Road, Bengaluru');
    expect(place.approximate).toBe(false);
  });

  it('still refuses a partial match, with the null shape', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(resultWith({ partial_match: true })),
    );
    const place = await provider.forwardGeocode('MADHEPUR, Bihar');
    expect(place).toEqual({
      formattedAddress: null,
      latitude: null,
      longitude: null,
      approximate: false,
      city: null,
      state: null,
      pincode: null,
    });
  });
});
