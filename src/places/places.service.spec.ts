import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';
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
});
