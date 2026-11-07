import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PlacesService } from './places.service';
import { MockPlacesProvider } from './mock-places.provider';
import { PlacesProvider, ForwardGeocodedPlace } from './places-provider';
import { PlacesRateLimitStore } from './places-rate-limit.store';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';

/**
 * QA gaps in the staff forward geocode (story 1): the composed service with
 * the REAL mock fixtures (so "matches a fixture" means the real fixture), plus
 * coordinate shapes the existing service spec does not reach.
 */
const staff: RequestUser = {
  userId: '55555555-eeee-4eee-8eee-555555555555',
  tenantId: '66666666-ffff-4fff-8fff-666666666666',
  role: Role.PLATFORM_ADMIN,
  platformAdmin: true,
  rawJwt: 'jwt',
};
const NOT_FOUND: ForwardGeocodedPlace = {
  formattedAddress: null,
  latitude: null,
  longitude: null,
  approximate: false,
  city: null,
  state: null,
  pincode: null,
};
const KORAMANGALA = {
  formattedAddress: 'Koramangala, Bengaluru, Karnataka 560034, India',
  latitude: 12.9352,
  longitude: 77.6245,
  approximate: false,
  city: 'Bengaluru',
  state: null,
  pincode: '560034',
};

function service(provider: PlacesProvider): PlacesService {
  const store = {
    increment: jest
      .fn()
      .mockResolvedValue({ count: 1, windowRemainingSeconds: 60 }),
  };
  const config = { get: () => undefined } as unknown as ConfigService;
  return new PlacesService(
    provider,
    store as unknown as PlacesRateLimitStore,
    config,
  );
}

const realMock = () =>
  new MockPlacesProvider({
    getOrThrow: () => 'test-key',
  } as unknown as ConfigService);

describe('staff forward geocode gaps (QA)', () => {
  describe('empty and whitespace address against the real fixtures', () => {
    it.each([
      [
        'an empty address with a city that is a fixture',
        { address: '', city: 'Bengaluru' },
      ],
      [
        'an empty address with a pincode that is a fixture',
        { address: '', pincode: '560034' },
      ],
      [
        'a whitespace address with a city that is a fixture',
        { address: '   ', city: 'Bengaluru' },
      ],
      ['a tab and newline address', { address: '\t\n', state: 'Karnataka' }],
      ['an empty address with a state', { address: '', state: 'Karnataka' }],
    ])('%s is not found, never a fixture match', async (_label, parts) => {
      await expect(
        service(realMock()).geocodeAddress(staff, parts),
      ).resolves.toEqual(NOT_FOUND);
    });

    it('a real address with a city still finds the fixture (control case)', async () => {
      await expect(
        service(realMock()).geocodeAddress(staff, {
          address: 'Koramangala',
          city: 'Bengaluru',
        }),
      ).resolves.toEqual(KORAMANGALA);
    });
  });

  describe('the service sends only the filled parts', () => {
    it('does not send a whitespace-only city or state to the provider', async () => {
      const provider = {
        forwardGeocode: jest.fn().mockResolvedValue(NOT_FOUND),
      };
      await service(provider as unknown as PlacesProvider).geocodeAddress(
        staff,
        {
          address: 'Koramangala',
          city: '   ',
          state: '',
        },
      );
      expect(provider.forwardGeocode).toHaveBeenCalledWith('Koramangala');
    });

    it('joins the filled parts in order, separated by commas', async () => {
      const provider = {
        forwardGeocode: jest.fn().mockResolvedValue(NOT_FOUND),
      };
      await service(provider as unknown as PlacesProvider).geocodeAddress(
        staff,
        {
          address: '12 MG Road',
          city: 'Bengaluru',
          state: 'Karnataka',
          pincode: '560001',
        },
      );
      expect(provider.forwardGeocode).toHaveBeenCalledWith(
        '12 MG Road, Bengaluru, Karnataka, 560001',
      );
    });
  });

  describe('coordinate shapes from the provider (refused with 502)', () => {
    const provide = (value: unknown) =>
      ({
        forwardGeocode: jest.fn().mockResolvedValue(value),
      }) as unknown as PlacesProvider;

    it.each([
      [
        'positive infinity latitude',
        { latitude: Number.POSITIVE_INFINITY, longitude: 77 },
      ],
      [
        'negative infinity latitude',
        { latitude: Number.NEGATIVE_INFINITY, longitude: 77 },
      ],
      [
        'infinite longitude',
        { latitude: 12, longitude: Number.POSITIVE_INFINITY },
      ],
      [
        'negative infinite longitude',
        { latitude: 12, longitude: Number.NEGATIVE_INFINITY },
      ],
      ['latitude just over 90', { latitude: 90.000001, longitude: 77 }],
      ['latitude just under -90', { latitude: -90.000001, longitude: 77 }],
      ['longitude just over 180', { latitude: 12, longitude: 180.000001 }],
      ['longitude just under -180', { latitude: 12, longitude: -180.000001 }],
      [
        'longitude missing from the result',
        { latitude: 12, formattedAddress: 'x' },
      ],
      [
        'latitude missing from the result',
        { longitude: 77, formattedAddress: 'x' },
      ],
      ['both coordinates missing from the result', { formattedAddress: 'x' }],
      ['longitude null with latitude set', { latitude: 12, longitude: null }],
      ['latitude null with longitude set', { latitude: null, longitude: 77 }],
      ['latitude as text', { latitude: '12.9', longitude: 77 }],
    ])('refuses %s with 502', async (_label, value) => {
      await expect(
        service(provide({ formattedAddress: 'x', ...value })).geocodeAddress(
          staff,
          { address: 'Somewhere' },
        ),
      ).rejects.toMatchObject({ status: 502 });
    });

    it.each([
      ['latitude 90 and longitude 180', 90, 180],
      ['latitude -90 and longitude -180', -90, -180],
      ['zero and zero', 0, 0],
    ])(
      'passes exact boundary coordinates through: %s',
      async (_label, latitude, longitude) => {
        const result = { formattedAddress: 'x', latitude, longitude };
        await expect(
          service(provide(result)).geocodeAddress(staff, {
            address: 'Somewhere',
          }),
        ).resolves.toEqual(result);
      },
    );
  });

  describe('logs for a failed lookup hold no address and no key', () => {
    it('logs the failure without the typed address or the API key', async () => {
      const logged: string[] = [];
      const errorSpy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation((...args: unknown[]) => {
          logged.push(JSON.stringify(args));
        });
      const provider = {
        forwardGeocode: jest
          .fn()
          .mockRejectedValue(
            new Error('Google Geocoding request failed with status 500'),
          ),
      } as unknown as PlacesProvider;
      await expect(
        service(provider).geocodeAddress(staff, {
          address: '77 Secret Lane',
          city: 'Bengaluru',
        }),
      ).rejects.toMatchObject({ status: 502 });
      errorSpy.mockRestore();
      const all = logged.join('\n');
      expect(logged.length).toBeGreaterThan(0);
      expect(all).not.toContain('Secret Lane');
      expect(all).not.toContain('test-key');
    });
  });
});
