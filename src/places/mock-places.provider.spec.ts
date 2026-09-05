import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  MockPlacesProvider,
  SIMULATE_PROVIDER_ERROR_QUERY,
  SIMULATE_RESOLVE_ERROR_PLACE_ID,
} from './mock-places.provider';

describe('MockPlacesProvider', () => {
  let provider: MockPlacesProvider;
  const originalNodeEnv = process.env['NODE_ENV'];

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MockPlacesProvider,
        {
          provide: ConfigService,
          useValue: { getOrThrow: jest.fn().mockReturnValue('test-key') },
        },
      ],
    }).compile();

    provider = module.get(MockPlacesProvider);
  });

  afterEach(() => {
    process.env['NODE_ENV'] = originalNodeEnv;
  });

  it('should return deterministic fixture suggestions for a known query', async () => {
    const suggestions = await provider.autosuggest(
      'andheri w',
      'session-1',
      'IN',
    );

    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0]).toMatchObject({
      placeId: expect.any(String),
      text: expect.any(String),
    });
  });

  it('should return an empty array for a query matching no fixture', async () => {
    const suggestions = await provider.autosuggest(
      'no-such-place-xyz',
      'session-1',
      'IN',
    );

    expect(suggestions).toEqual([]);
  });

  it('should reject with the sentinel query outside production (real DI-bound path)', async () => {
    process.env['NODE_ENV'] = 'test';

    await expect(
      provider.autosuggest(SIMULATE_PROVIDER_ERROR_QUERY, 'session-1', 'IN'),
    ).rejects.toThrow('Simulated Places provider failure');
  });

  it('should NOT honor the sentinel query when NODE_ENV is production', async () => {
    process.env['NODE_ENV'] = 'production';

    const suggestions = await provider.autosuggest(
      SIMULATE_PROVIDER_ERROR_QUERY,
      'session-1',
      'IN',
    );

    expect(suggestions).toEqual([]);
  });

  describe('resolve', () => {
    it('should return the deterministic fixture for a known placeId', async () => {
      const resolved = await provider.resolve(
        'mock-place-andheri-west-1',
        'session-1',
        'IN',
      );

      expect(resolved).toMatchObject({
        placeId: 'mock-place-andheri-west-1',
        formattedAddress: expect.any(String),
        city: expect.any(String),
        pincode: expect.any(String),
        latitude: expect.any(Number),
        longitude: expect.any(Number),
      });
    });

    it('should return city: null and pincode: null for the nullable-fields fixture', async () => {
      const resolved = await provider.resolve(
        'mock-place-koramangala-sublocality-1',
        'session-1',
        'IN',
      );

      expect(resolved.city).toBeNull();
      expect(resolved.pincode).toBeNull();
      expect(typeof resolved.latitude).toBe('number');
      expect(typeof resolved.longitude).toBe('number');
    });

    it('should reject with the sentinel placeId outside production (real DI-bound path)', async () => {
      process.env['NODE_ENV'] = 'test';

      await expect(
        provider.resolve(SIMULATE_RESOLVE_ERROR_PLACE_ID, 'session-1', 'IN'),
      ).rejects.toThrow('Simulated Places resolve provider failure');
    });

    it('should reject the sentinel placeId as an unknown fixture when NODE_ENV is production', async () => {
      process.env['NODE_ENV'] = 'production';

      await expect(
        provider.resolve(SIMULATE_RESOLVE_ERROR_PLACE_ID, 'session-1', 'IN'),
      ).rejects.toThrow();
    });

    it('should reject an unrecognized placeId (never issued by autosuggest)', async () => {
      await expect(
        provider.resolve('mock-place-does-not-exist', 'session-1', 'IN'),
      ).rejects.toThrow();
    });

    it('should reject inherited Object.prototype member names instead of resolving them as fixtures', async () => {
      await expect(
        provider.resolve('constructor', 'session-1', 'IN'),
      ).rejects.toThrow();
    });

    it('should resolve a placeId returned by a prior autosuggest call (full mock round trip)', async () => {
      const suggestions = await provider.autosuggest(
        'andheri w',
        'session-1',
        'IN',
      );
      const [firstSuggestion] = suggestions;

      const resolved = await provider.resolve(
        firstSuggestion.placeId,
        'session-1',
        'IN',
      );

      expect(resolved.placeId).toBe(firstSuggestion.placeId);
    });
  });
});
