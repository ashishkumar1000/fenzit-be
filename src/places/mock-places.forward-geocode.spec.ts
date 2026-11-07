import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  MockPlacesProvider,
  SIMULATE_FORWARD_ERROR_ADDRESS,
} from './mock-places.provider';

const nullShape = { formattedAddress: null, latitude: null, longitude: null };

describe('MockPlacesProvider.forwardGeocode (QA)', () => {
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

  describe('matching', () => {
    it('should resolve a known Bengaluru address to its fixture coordinates', async () => {
      await expect(provider.forwardGeocode('Koramangala')).resolves.toEqual({
        formattedAddress: 'Koramangala, Bengaluru, Karnataka 560034, India',
        latitude: 12.9352,
        longitude: 77.6245,
      });
    });

    it('should match regardless of letter case', async () => {
      const upper = await provider.forwardGeocode('ANDHERI WEST');
      const mixed = await provider.forwardGeocode('aNdHeRi WeSt');

      expect(upper.latitude).toBe(19.1364);
      expect(mixed).toEqual(upper);
    });

    it('should ignore leading and trailing whitespace in the typed address', async () => {
      await expect(
        provider.forwardGeocode('   Koramangala  '),
      ).resolves.toMatchObject({
        latitude: 12.9352,
      });
    });

    it('should return the null shape (never throw) for an address matching no fixture', async () => {
      await expect(
        provider.forwardGeocode('Atlantis Harbour 9'),
      ).resolves.toEqual(nullShape);
    });

    it('should return the null shape for an empty string, which matches nothing', async () => {
      // A blank address is not a match for "everything". Without this, the
      // empty needle would fall through to the first fixture.
      await expect(provider.forwardGeocode('')).resolves.toEqual(nullShape);
    });

    it('should return the null shape for a whitespace-only address, which matches nothing', async () => {
      await expect(provider.forwardGeocode('      ')).resolves.toEqual(
        nullShape,
      );
    });

    it('should return the null shape for SQL-looking input without throwing', async () => {
      await expect(provider.forwardGeocode("' OR '1'='1")).resolves.toEqual(
        nullShape,
      );
    });

    it('should return the null shape for a very long (300 character) address without throwing', async () => {
      await expect(provider.forwardGeocode('x'.repeat(300))).resolves.toEqual(
        nullShape,
      );
    });

    it('should return the null shape for non-Latin input without throwing', async () => {
      await expect(provider.forwardGeocode('मुंबई')).resolves.toEqual(
        nullShape,
      );
    });
  });

  describe('simulated provider failure sentinel', () => {
    it('should throw the simulated failure outside production (NODE_ENV=test)', async () => {
      process.env['NODE_ENV'] = 'test';

      await expect(
        provider.forwardGeocode(SIMULATE_FORWARD_ERROR_ADDRESS),
      ).rejects.toThrow('Simulated Places forwardGeocode provider failure');
    });

    it('should throw the simulated failure in development too', async () => {
      process.env['NODE_ENV'] = 'development';

      await expect(
        provider.forwardGeocode(SIMULATE_FORWARD_ERROR_ADDRESS),
      ).rejects.toThrow();
    });

    it('should NOT throw the sentinel in production; a real owner typing it gets the null shape', async () => {
      process.env['NODE_ENV'] = 'production';

      await expect(
        provider.forwardGeocode(SIMULATE_FORWARD_ERROR_ADDRESS),
      ).resolves.toEqual(nullShape);
    });
  });
});
