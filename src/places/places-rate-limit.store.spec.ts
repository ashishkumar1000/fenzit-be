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

    const result = await store.increment('tenant-1:autosuggest', 60);

    expect(result.count).toBe(1);
    // A fresh window has its full ttl remaining.
    expect(result.windowRemainingSeconds).toBe(60);
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

    const result = await store.increment('tenant-1:autosuggest', 60);

    expect(result.count).toBe(4);
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

  it('should report the seconds REMAINING in the window, not its full length', async () => {
    // ~30s left of a 60s window → Retry-After must be ~30, not 60.
    const expiresAt = Date.now() + 29_500;
    cache.get.mockResolvedValue({ count: 3, expiresAt });

    const result = await store.increment('tenant-1:autosuggest', 60);

    expect(result.windowRemainingSeconds).toBe(30); // ceil(29.5)
  });

  it('should keep counters isolated per key', async () => {
    cache.get.mockResolvedValue(undefined);

    await store.increment('tenant-a:autosuggest', 60);
    await store.increment('tenant-b:autosuggest', 60);

    expect(cache.get).toHaveBeenCalledWith('places:rate:tenant-a:autosuggest');
    expect(cache.get).toHaveBeenCalledWith('places:rate:tenant-b:autosuggest');
  });

  it('should never let the remaining ttl (or the reported seconds) fall to zero when the window is nearly expired', async () => {
    cache.get.mockResolvedValue({ count: 1, expiresAt: Date.now() - 5_000 });

    const result = await store.increment('tenant-1:autosuggest', 60);

    expect(result.windowRemainingSeconds).toBeGreaterThanOrEqual(1);
    const [, , remainingMs] = cache.set.mock.calls[0] as [
      string,
      unknown,
      number,
    ];
    expect(remainingMs).toBeGreaterThanOrEqual(1);
  });
});
