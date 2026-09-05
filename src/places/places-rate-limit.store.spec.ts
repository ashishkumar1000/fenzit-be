import { Test, TestingModule } from '@nestjs/testing';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { PlacesRateLimitStore } from './places-rate-limit.store';

describe('PlacesRateLimitStore', () => {
  let store: PlacesRateLimitStore;
  let cache: { get: jest.Mock; set: jest.Mock };

  beforeEach(async () => {
    cache = {
      get: jest.fn(),
      set: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlacesRateLimitStore,
        { provide: CACHE_MANAGER, useValue: cache },
      ],
    }).compile();

    store = module.get(PlacesRateLimitStore);
  });

  it('should start a new window at count 1 under the places:rate: prefix with the given ttl', async () => {
    cache.get.mockResolvedValue(undefined);

    const count = await store.increment('tenant-1:autosuggest', 60);

    expect(count).toBe(1);
    expect(cache.get).toHaveBeenCalledWith('places:rate:tenant-1:autosuggest');
    expect(cache.set).toHaveBeenCalledWith(
      'places:rate:tenant-1:autosuggest',
      expect.objectContaining({ count: 1 }),
      60_000,
    );
  });

  it('should increment an existing window and preserve its original expiry', async () => {
    const expiresAt = Date.now() + 30_000;
    cache.get.mockResolvedValue({ count: 3, expiresAt });

    const count = await store.increment('tenant-1:autosuggest', 60);

    expect(count).toBe(4);
    expect(cache.set).toHaveBeenCalledWith(
      'places:rate:tenant-1:autosuggest',
      { count: 4, expiresAt },
      expect.any(Number),
    );
    const [, , remainingMs] = cache.set.mock.calls[0] as [
      string,
      unknown,
      number,
    ];
    expect(remainingMs).toBeGreaterThan(0);
    expect(remainingMs).toBeLessThanOrEqual(30_000);
  });

  it('should keep counters isolated per key', async () => {
    cache.get.mockResolvedValue(undefined);

    await store.increment('tenant-a:autosuggest', 60);
    await store.increment('tenant-b:autosuggest', 60);

    expect(cache.get).toHaveBeenCalledWith('places:rate:tenant-a:autosuggest');
    expect(cache.get).toHaveBeenCalledWith('places:rate:tenant-b:autosuggest');
  });

  it('should never let the remaining ttl fall to zero or below when the window is nearly expired', async () => {
    cache.get.mockResolvedValue({ count: 1, expiresAt: Date.now() - 5_000 });

    await store.increment('tenant-1:autosuggest', 60);

    const [, , remainingMs] = cache.set.mock.calls[0] as [
      string,
      unknown,
      number,
    ];
    expect(remainingMs).toBeGreaterThanOrEqual(1);
  });
});
