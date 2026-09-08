import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PlacesService } from './places.service';
import {
  PlacesProvider,
  PlaceSuggestion,
  ResolvedPlace,
} from './places-provider';
import { PlacesRateLimitStore } from './places-rate-limit.store';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import { ErrorCode } from '../common/enums/error-code.enum';

describe('PlacesService', () => {
  let service: PlacesService;
  let placesProvider: jest.Mocked<PlacesProvider>;
  let rateLimitStore: jest.Mocked<PlacesRateLimitStore>;

  const ownerUser: RequestUser = {
    userId: '550e8400-e29b-41d4-a716-446655440000',
    tenantId: 'tenant-uuid-111',
    role: Role.OWNER,
    rawJwt: 'mock-jwt',
  };

  const sessionToken = 'a1b2c3d4-0000-4000-8000-000000000001';

  beforeEach(async () => {
    const mockPlacesProvider = {
      autosuggest: jest.fn(),
      resolve: jest.fn(),
    };

    const mockRateLimitStore = {
      increment: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlacesService,
        { provide: PlacesProvider, useValue: mockPlacesProvider },
        { provide: PlacesRateLimitStore, useValue: mockRateLimitStore },
        // get() returns undefined by default so every env-overridable budget
        // falls back to its exported default constant.
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(undefined) },
        },
      ],
    }).compile();

    service = module.get<PlacesService>(PlacesService);
    placesProvider = module.get(PlacesProvider);
    rateLimitStore = module.get(PlacesRateLimitStore);
  });

  it('should return suggestions from the provider on the happy path', async () => {
    const suggestions: PlaceSuggestion[] = [
      { placeId: 'mock-place-andheri-west-1', text: 'Andheri West, Mumbai' },
    ];
    rateLimitStore.increment.mockResolvedValue(1);
    placesProvider.autosuggest.mockResolvedValue(suggestions);

    const result = await service.autosuggest(
      ownerUser,
      'andheri w',
      sessionToken,
    );

    expect(result).toEqual({ suggestions });
    expect(rateLimitStore.increment).toHaveBeenCalledWith(
      'tenant-uuid-111:autosuggest',
      60,
    );
    expect(placesProvider.autosuggest).toHaveBeenCalledWith(
      'andheri w',
      sessionToken,
      'IN',
    );
  });

  it('should return an empty suggestions array without error when the provider finds nothing', async () => {
    rateLimitStore.increment.mockResolvedValue(1);
    placesProvider.autosuggest.mockResolvedValue([]);

    const result = await service.autosuggest(
      ownerUser,
      'no-such-place',
      sessionToken,
    );

    expect(result).toEqual({ suggestions: [] });
  });

  it('should throw 429 RATE_LIMITED and never call the provider once the budget is exceeded', async () => {
    rateLimitStore.increment.mockResolvedValue(31);

    await expect(
      service.autosuggest(ownerUser, 'andheri w', sessionToken),
    ).rejects.toMatchObject({
      status: 429,
      response: expect.objectContaining({
        error_code: ErrorCode.RATE_LIMITED,
        // GlobalExceptionFilter lifts this into a Retry-After response header.
        retryAfterSeconds: 60,
      }),
    });
    expect(placesProvider.autosuggest).not.toHaveBeenCalled();
  });

  it('should throw 502 PLACES_UPSTREAM_ERROR when the provider throws', async () => {
    rateLimitStore.increment.mockResolvedValue(1);
    placesProvider.autosuggest.mockRejectedValue(
      new Error('Simulated Places provider failure'),
    );

    await expect(
      service.autosuggest(ownerUser, 'andheri w', sessionToken),
    ).rejects.toMatchObject({
      status: 502,
      response: expect.objectContaining({
        error_code: ErrorCode.PLACES_UPSTREAM_ERROR,
      }),
    });
  });

  it('should raise a plain HttpException (not swallow it) on provider failure', async () => {
    rateLimitStore.increment.mockResolvedValue(1);
    placesProvider.autosuggest.mockRejectedValue(new Error('boom'));

    await expect(
      service.autosuggest(ownerUser, 'andheri w', sessionToken),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('should throw 502 PLACES_UPSTREAM_ERROR (not a bare 500) when the rate-limit store itself throws', async () => {
    rateLimitStore.increment.mockRejectedValue(new Error('cache backend down'));

    await expect(
      service.autosuggest(ownerUser, 'andheri w', sessionToken),
    ).rejects.toMatchObject({
      status: 502,
      response: expect.objectContaining({
        error_code: ErrorCode.PLACES_UPSTREAM_ERROR,
      }),
    });
    expect(placesProvider.autosuggest).not.toHaveBeenCalled();
  });

  it('should key the rate limit by userId when the owner has no tenantId yet', async () => {
    const noTenantOwner: RequestUser = { ...ownerUser, tenantId: null };
    rateLimitStore.increment.mockResolvedValue(1);
    placesProvider.autosuggest.mockResolvedValue([]);

    await service.autosuggest(noTenantOwner, 'andheri w', sessionToken);

    expect(rateLimitStore.increment).toHaveBeenCalledWith(
      `${noTenantOwner.userId}:autosuggest`,
      60,
    );
  });

  describe('resolve', () => {
    const placeId = 'mock-place-andheri-west-1';
    const resolvedPlace: ResolvedPlace = {
      placeId,
      formattedAddress: 'Andheri West, Mumbai, Maharashtra 400058, India',
      city: 'Mumbai',
      pincode: '400058',
      latitude: 19.1364,
      longitude: 72.8296,
    };

    it('should return the resolved place from the provider on the happy path', async () => {
      rateLimitStore.increment.mockResolvedValue(1);
      placesProvider.resolve.mockResolvedValue(resolvedPlace);

      const result = await service.resolve(ownerUser, placeId, sessionToken);

      expect(result).toEqual(resolvedPlace);
      expect(rateLimitStore.increment).toHaveBeenCalledWith(
        'tenant-uuid-111:resolve',
        60,
      );
      expect(placesProvider.resolve).toHaveBeenCalledWith(
        placeId,
        sessionToken,
        'IN',
      );
    });

    it('should return null city/pincode as-is (never coerced) when the provider omits them', async () => {
      const nullableFixture: ResolvedPlace = {
        ...resolvedPlace,
        city: null,
        pincode: null,
      };
      rateLimitStore.increment.mockResolvedValue(1);
      placesProvider.resolve.mockResolvedValue(nullableFixture);

      const result = await service.resolve(ownerUser, placeId, sessionToken);

      expect(result.city).toBeNull();
      expect(result.pincode).toBeNull();
    });

    it('should throw 429 RATE_LIMITED and never call the provider once the resolve budget is exceeded', async () => {
      rateLimitStore.increment.mockResolvedValue(11);

      await expect(
        service.resolve(ownerUser, placeId, sessionToken),
      ).rejects.toMatchObject({
        status: 429,
        response: expect.objectContaining({
          error_code: ErrorCode.RATE_LIMITED,
        }),
      });
      expect(placesProvider.resolve).not.toHaveBeenCalled();
    });

    it('should throw 502 PLACES_UPSTREAM_ERROR when the provider throws (including no resolvable location)', async () => {
      rateLimitStore.increment.mockResolvedValue(1);
      placesProvider.resolve.mockRejectedValue(
        new Error('Simulated Places resolve provider failure'),
      );

      await expect(
        service.resolve(ownerUser, placeId, sessionToken),
      ).rejects.toMatchObject({
        status: 502,
        response: expect.objectContaining({
          error_code: ErrorCode.PLACES_UPSTREAM_ERROR,
          message: 'Unable to resolve the selected address right now',
        }),
      });
    });

    it('should throw 502 PLACES_UPSTREAM_ERROR (not a bare 500) when the rate-limit store itself throws', async () => {
      rateLimitStore.increment.mockRejectedValue(
        new Error('cache backend down'),
      );

      await expect(
        service.resolve(ownerUser, placeId, sessionToken),
      ).rejects.toMatchObject({
        status: 502,
        response: expect.objectContaining({
          error_code: ErrorCode.PLACES_UPSTREAM_ERROR,
        }),
      });
      expect(placesProvider.resolve).not.toHaveBeenCalled();
    });

    it('should throw 502 PLACES_UPSTREAM_ERROR when the provider returns non-finite coordinates (NaN/Infinity)', async () => {
      rateLimitStore.increment.mockResolvedValue(1);
      placesProvider.resolve.mockResolvedValue({
        ...resolvedPlace,
        latitude: NaN,
        longitude: Infinity,
      });

      await expect(
        service.resolve(ownerUser, placeId, sessionToken),
      ).rejects.toMatchObject({
        status: 502,
        response: expect.objectContaining({
          error_code: ErrorCode.PLACES_UPSTREAM_ERROR,
          message: 'Unable to resolve the selected address right now',
        }),
      });
    });

    it('should throw 502 PLACES_UPSTREAM_ERROR when the provider returns finite-but-out-of-range coordinates', async () => {
      rateLimitStore.increment.mockResolvedValue(1);
      placesProvider.resolve.mockResolvedValue({
        ...resolvedPlace,
        latitude: 999,
        longitude: -200,
      });

      await expect(
        service.resolve(ownerUser, placeId, sessionToken),
      ).rejects.toMatchObject({
        status: 502,
        response: expect.objectContaining({
          error_code: ErrorCode.PLACES_UPSTREAM_ERROR,
          message: 'Unable to resolve the selected address right now',
        }),
      });
    });

    it('should accept boundary coordinates (±90 lat, ±180 lng) as valid', async () => {
      rateLimitStore.increment.mockResolvedValue(1);
      placesProvider.resolve.mockResolvedValue({
        ...resolvedPlace,
        latitude: 90,
        longitude: -180,
      });

      await expect(
        service.resolve(ownerUser, placeId, sessionToken),
      ).resolves.toMatchObject({ latitude: 90, longitude: -180 });
    });

    it('should key the resolve rate limit independently from autosuggest (separate suffix)', async () => {
      rateLimitStore.increment.mockResolvedValue(1);
      placesProvider.resolve.mockResolvedValue(resolvedPlace);

      await service.resolve(ownerUser, placeId, sessionToken);

      expect(rateLimitStore.increment).toHaveBeenCalledWith(
        expect.stringContaining(':resolve'),
        expect.any(Number),
      );
      expect(rateLimitStore.increment).not.toHaveBeenCalledWith(
        expect.stringContaining(':autosuggest'),
        expect.any(Number),
      );
    });
  });

  describe('env-overridable rate-limit budgets', () => {
    it('should read the autosuggest budget from config/env when set, falling back to defaults per key', async () => {
      const configGet = jest.fn(
        (key: string) =>
          key === 'PLACES_AUTOSUGGEST_RATE_LIMIT_MAX' ? 1 : undefined,
      );
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          PlacesService,
          {
            provide: PlacesProvider,
            useValue: { autosuggest: jest.fn(), resolve: jest.fn() },
          },
          { provide: PlacesRateLimitStore, useValue: { increment: jest.fn() } },
          { provide: ConfigService, useValue: { get: configGet } },
        ],
      }).compile();

      const envService = module.get<PlacesService>(PlacesService);
      const envStore = module.get(PlacesRateLimitStore) as unknown as {
        increment: jest.Mock;
      };
      envStore.increment.mockResolvedValue(2);

      // First request already over the overridden budget of 1 → 429, and the
      // window passed to the store is the (unset) default of 60.
      await expect(
        envService.autosuggest(ownerUser, 'andheri w', sessionToken),
      ).rejects.toMatchObject({ status: 429 });
      expect(envStore.increment).toHaveBeenCalledWith(
        'tenant-uuid-111:autosuggest',
        60,
      );
      expect(configGet).toHaveBeenCalledWith(
        'PLACES_AUTOSUGGEST_RATE_LIMIT_MAX',
      );
    });

    it('should read the resolve budget from config/env when set, falling back to defaults per key', async () => {
      const configGet = jest.fn(
        (key: string) =>
          key === 'PLACES_RESOLVE_RATE_LIMIT_MAX' ? 1 : undefined,
      );
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          PlacesService,
          {
            provide: PlacesProvider,
            useValue: { autosuggest: jest.fn(), resolve: jest.fn() },
          },
          { provide: PlacesRateLimitStore, useValue: { increment: jest.fn() } },
          { provide: ConfigService, useValue: { get: configGet } },
        ],
      }).compile();

      const envService = module.get<PlacesService>(PlacesService);
      const envStore = module.get(PlacesRateLimitStore) as unknown as {
        increment: jest.Mock;
      };
      envStore.increment.mockResolvedValue(2);

      // First request already over the overridden budget of 1 → 429, and the
      // window passed to the store is the (unset) default of 60.
      await expect(
        envService.resolve(ownerUser, 'mock-place-andheri-west-1', sessionToken),
      ).rejects.toMatchObject({ status: 429 });
      expect(envStore.increment).toHaveBeenCalledWith(
        'tenant-uuid-111:resolve',
        60,
      );
      expect(configGet).toHaveBeenCalledWith('PLACES_RESOLVE_RATE_LIMIT_MAX');
    });
  });
});
