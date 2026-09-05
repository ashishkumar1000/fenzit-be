import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';
import { PlacesService } from './places.service';
import { PlacesProvider, PlaceSuggestion } from './places-provider';
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
});
