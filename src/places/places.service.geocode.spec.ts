import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PlacesService } from './places.service';
import { PlacesProvider, ForwardGeocodedPlace } from './places-provider';
import { PlacesRateLimitStore } from './places-rate-limit.store';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import { ErrorCode } from '../common/enums/error-code.enum';

const API_KEY = 'test-google-api-key';
const UPSTREAM_MESSAGE =
  'Unable to find coordinates for this address right now';

describe('PlacesService.geocodeAddress (QA)', () => {
  let service: PlacesService;
  let placesProvider: { forwardGeocode: jest.Mock };
  let rateLimitStore: { increment: jest.Mock };
  let configGet: jest.Mock;

  const staffUser: RequestUser = {
    userId: '550e8400-e29b-41d4-a716-446655440000',
    tenantId: 'tenant-uuid-111',
    role: Role.PLATFORM_ADMIN,
    platformAdmin: true,
    rawJwt: 'mock-jwt',
  };

  const found: ForwardGeocodedPlace = {
    formattedAddress: 'Koramangala, Bengaluru, Karnataka 560034, India',
    latitude: 12.9352,
    longitude: 77.6245,
  };
  const notFound: ForwardGeocodedPlace = {
    formattedAddress: null,
    latitude: null,
    longitude: null,
  };

  async function buildService(
    env: Record<string, number | undefined> = {},
  ): Promise<void> {
    placesProvider = { forwardGeocode: jest.fn() };
    rateLimitStore = { increment: jest.fn() };
    configGet = jest.fn((key: string) => env[key]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlacesService,
        { provide: PlacesProvider, useValue: placesProvider },
        { provide: PlacesRateLimitStore, useValue: rateLimitStore },
        { provide: ConfigService, useValue: { get: configGet } },
      ],
    }).compile();

    service = module.get(PlacesService);
  }

  /** Makes the next increment report `count` requests in the window. */
  const countIs = (count: number, windowRemainingSeconds = 60) =>
    rateLimitStore.increment.mockResolvedValue({
      count,
      windowRemainingSeconds,
    });

  beforeEach(async () => {
    await buildService();
  });

  describe('happy path and passthrough', () => {
    it('should return the provider coordinates for a found address', async () => {
      countIs(1);
      placesProvider.forwardGeocode.mockResolvedValue(found);

      await expect(
        service.geocodeAddress(staffUser, { address: 'Koramangala' }),
      ).resolves.toEqual(found);
      expect(placesProvider.forwardGeocode).toHaveBeenCalledWith('Koramangala');
    });

    it('should pass the null shape through as a success, never a throw', async () => {
      countIs(1);
      placesProvider.forwardGeocode.mockResolvedValue(notFound);

      await expect(
        service.geocodeAddress(staffUser, { address: 'Atlantis 9' }),
      ).resolves.toEqual(notFound);
    });

    it('should call the provider exactly once per request (no silent retry)', async () => {
      countIs(1);
      placesProvider.forwardGeocode.mockResolvedValue(found);

      await service.geocodeAddress(staffUser, { address: 'Koramangala' });

      expect(placesProvider.forwardGeocode).toHaveBeenCalledTimes(1);
    });
  });

  describe('rate limit boundary (60 per minute default)', () => {
    it('should allow the 60th request in the window', async () => {
      countIs(60);
      placesProvider.forwardGeocode.mockResolvedValue(found);

      await expect(
        service.geocodeAddress(staffUser, { address: 'Koramangala' }),
      ).resolves.toEqual(found);
    });

    it('should refuse the 61st request with 429 RATE_LIMITED and a Retry-After value', async () => {
      countIs(61, 42);

      await expect(
        service.geocodeAddress(staffUser, { address: 'Koramangala' }),
      ).rejects.toMatchObject({
        status: 429,
        response: expect.objectContaining({
          error_code: ErrorCode.RATE_LIMITED,
          retryAfterSeconds: 42,
        }),
      });
    });

    it('should never call the provider once the budget is exceeded', async () => {
      countIs(61);

      await expect(
        service.geocodeAddress(staffUser, { address: 'Koramangala' }),
      ).rejects.toBeInstanceOf(HttpException);
      expect(placesProvider.forwardGeocode).not.toHaveBeenCalled();
    });

    it('should honour a custom PLACES_GEOCODE_RATE_LIMIT_MAX (boundary at 5)', async () => {
      await buildService({ PLACES_GEOCODE_RATE_LIMIT_MAX: 5 });
      countIs(5);
      placesProvider.forwardGeocode.mockResolvedValue(found);
      await expect(
        service.geocodeAddress(staffUser, { address: 'x' }),
      ).resolves.toEqual(found);

      rateLimitStore.increment.mockResolvedValue({
        count: 6,
        windowRemainingSeconds: 60,
      });
      await expect(
        service.geocodeAddress(staffUser, { address: 'x' }),
      ).rejects.toMatchObject({
        status: 429,
      });
    });

    it('should honour a custom PLACES_GEOCODE_RATE_LIMIT_WINDOW_SECONDS in the store call', async () => {
      await buildService({ PLACES_GEOCODE_RATE_LIMIT_WINDOW_SECONDS: 300 });
      countIs(1);
      placesProvider.forwardGeocode.mockResolvedValue(found);

      await service.geocodeAddress(staffUser, { address: 'Koramangala' });

      expect(rateLimitStore.increment).toHaveBeenCalledWith(
        `${staffUser.userId}:geocode`,
        300,
      );
    });

    it('should fall back to the 60 second window and 60 max when the env vars are unset', async () => {
      countIs(1);
      placesProvider.forwardGeocode.mockResolvedValue(found);

      await service.geocodeAddress(staffUser, { address: 'Koramangala' });

      expect(rateLimitStore.increment).toHaveBeenCalledWith(
        `${staffUser.userId}:geocode`,
        60,
      );
      expect(configGet).toHaveBeenCalledWith('PLACES_GEOCODE_RATE_LIMIT_MAX');
    });
  });

  describe('rate-limit keying (per staff user, not per tenant)', () => {
    it('should key the budget by userId, not tenantId', async () => {
      countIs(1);
      placesProvider.forwardGeocode.mockResolvedValue(found);

      await service.geocodeAddress(staffUser, { address: 'Koramangala' });

      expect(rateLimitStore.increment).toHaveBeenCalledWith(
        `${staffUser.userId}:geocode`,
        60,
      );
      const key = rateLimitStore.increment.mock.calls[0][0] as string;
      expect(key).not.toContain(staffUser.tenantId as string);
    });

    it('refuses a staff user with no company before any lookup or budget use', async () => {
      placesProvider.forwardGeocode.mockResolvedValue(found);

      await expect(
        service.geocodeAddress(
          { ...staffUser, tenantId: null },
          {
            address: 'x',
          },
        ),
      ).rejects.toMatchObject({ status: 400 });

      expect(placesProvider.forwardGeocode).not.toHaveBeenCalled();
      expect(rateLimitStore.increment).not.toHaveBeenCalled();
    });

    it('keys the budget by userId for a staff user with a company', async () => {
      countIs(1);
      placesProvider.forwardGeocode.mockResolvedValue(found);

      await service.geocodeAddress(staffUser, { address: 'Koramangala' });

      expect(rateLimitStore.increment).toHaveBeenCalledWith(
        `${staffUser.userId}:geocode`,
        60,
      );
    });

    it('should not share a budget with autosuggest, resolve or reverse for the same user', async () => {
      countIs(1);
      placesProvider.forwardGeocode.mockResolvedValue(found);

      await service.geocodeAddress(staffUser, { address: 'Koramangala' });

      const key = rateLimitStore.increment.mock.calls[0][0] as string;
      expect(key.endsWith(':geocode')).toBe(true);
      expect(key).not.toMatch(/:(autosuggest|resolve|reverse)$/);
    });
  });

  describe('provider and store failures (502, documented envelope)', () => {
    it('should map a provider throw to 502 PLACES_UPSTREAM_ERROR with the fixed user message', async () => {
      countIs(1);
      placesProvider.forwardGeocode.mockRejectedValue(new Error('boom'));

      await expect(
        service.geocodeAddress(staffUser, { address: 'Koramangala' }),
      ).rejects.toMatchObject({
        status: 502,
        response: {
          error_code: ErrorCode.PLACES_UPSTREAM_ERROR,
          message: UPSTREAM_MESSAGE,
        },
      });
    });

    it('should map a provider that rejects with a non-Error value to 502 too', async () => {
      countIs(1);
      placesProvider.forwardGeocode.mockRejectedValue('network down');

      await expect(
        service.geocodeAddress(staffUser, { address: 'Koramangala' }),
      ).rejects.toMatchObject({ status: 502 });
    });

    it('should never leak the API key from a provider error into the 502 response body', async () => {
      countIs(1);
      placesProvider.forwardGeocode.mockRejectedValue(
        new Error(`request to maps.googleapis.com?key=${API_KEY} failed`),
      );

      let body = '';
      try {
        await service.geocodeAddress(staffUser, { address: 'Koramangala' });
      } catch (error) {
        body = JSON.stringify((error as HttpException).getResponse());
      }

      expect(body).not.toBe('');
      expect(body).not.toContain(API_KEY);
    });

    it('should map a rate-limit store failure to 502 and never call the provider', async () => {
      rateLimitStore.increment.mockRejectedValue(
        new Error('cache backend down'),
      );

      await expect(
        service.geocodeAddress(staffUser, { address: 'Koramangala' }),
      ).rejects.toMatchObject({
        status: 502,
        response: { error_code: ErrorCode.PLACES_UPSTREAM_ERROR },
      });
      expect(placesProvider.forwardGeocode).not.toHaveBeenCalled();
    });
  });

  describe('provider returns an invalid coordinate shape (contract guard)', () => {
    // ForwardGeocodedPlace contract: coordinates are both real finite numbers
    // (lat in [-90, 90], lng in [-180, 180]) or both null. Anything else must
    // be refused with 502 before it reaches a client. Mirrors resolve().

    it('should refuse NaN coordinates with 502', async () => {
      countIs(1);
      placesProvider.forwardGeocode.mockResolvedValue({
        formattedAddress: 'Somewhere',
        latitude: NaN,
        longitude: NaN,
      });

      await expect(
        service.geocodeAddress(staffUser, { address: 'Somewhere' }),
      ).rejects.toMatchObject({ status: 502 });
    });

    it('should refuse a latitude outside [-90, 90] with 502', async () => {
      countIs(1);
      placesProvider.forwardGeocode.mockResolvedValue({
        formattedAddress: 'Somewhere',
        latitude: 200,
        longitude: 77,
      });

      await expect(
        service.geocodeAddress(staffUser, { address: 'Somewhere' }),
      ).rejects.toMatchObject({ status: 502 });
    });

    it('should refuse a half-null result (latitude set, longitude null) with 502', async () => {
      countIs(1);
      placesProvider.forwardGeocode.mockResolvedValue({
        formattedAddress: 'Somewhere',
        latitude: 12.9,
        longitude: null,
      } as unknown as ForwardGeocodedPlace);

      await expect(
        service.geocodeAddress(staffUser, { address: 'Somewhere' }),
      ).rejects.toMatchObject({ status: 502 });
    });
  });
});
