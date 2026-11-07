import { Test, TestingModule } from '@nestjs/testing';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { createCache, type Cache } from 'cache-manager';
import { PlacesRateLimitStore } from './places-rate-limit.store';

/**
 * QA view of the geocode rate limiter's counter. These tests use a REAL
 * in-memory cache-manager instance (not a mock) so the get/set awaits really
 * yield to the event loop, which is what let concurrent calls interleave.
 *
 * Time is controlled through Date.now so window expiry is deterministic.
 */
describe('PlacesRateLimitStore — concurrency and windows (QA)', () => {
  const LIMIT = 60;
  const WINDOW_SECONDS = 60;

  let store: PlacesRateLimitStore;
  let cache: Cache;
  let now: number;
  let nowSpy: jest.SpyInstance<number, []>;

  beforeEach(async () => {
    now = 1_700_000_000_000;
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);

    cache = createCache();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlacesRateLimitStore,
        { provide: CACHE_MANAGER, useValue: cache },
      ],
    }).compile();

    store = module.get(PlacesRateLimitStore);
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  // The service refuses a call when count > LIMIT. The store only counts,
  // so the QA check derives "allowed" from the count it returns.
  const allowedOf = (counts: number[]): number =>
    counts.filter((count) => count <= LIMIT).length;

  it('200 concurrent calls for one key allow exactly 60 and refuse 140', async () => {
    const results = await Promise.all(
      Array.from({ length: 200 }, () =>
        store.increment('tenant-1:user-1:autosuggest', WINDOW_SECONDS),
      ),
    );
    const counts = results.map((result) => result.count);

    expect(allowedOf(counts)).toBe(LIMIT);
    expect(counts.filter((count) => count > LIMIT)).toHaveLength(140);
    // Every call must see a distinct count 1..200. Duplicates would mean two
    // calls read the same value and both wrote it back.
    expect([...counts].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 200 }, (_, index) => index + 1),
    );
  });

  it('calls for two different keys do not affect each other', async () => {
    const keyA = 'tenant-1:user-A:autosuggest';
    const keyB = 'tenant-1:user-B:autosuggest';

    const [resultsA, resultsB] = await Promise.all([
      Promise.all(
        Array.from({ length: 70 }, () => store.increment(keyA, WINDOW_SECONDS)),
      ),
      Promise.all(
        Array.from({ length: 5 }, () => store.increment(keyB, WINDOW_SECONDS)),
      ),
    ]);

    expect(resultsA.map((r) => r.count).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 70 }, (_, index) => index + 1),
    );
    expect(resultsB.map((r) => r.count).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it('the 61st call after the window has passed is allowed again', async () => {
    await Promise.all(
      Array.from({ length: LIMIT }, () =>
        store.increment('tenant-1:user-1:autosuggest', WINDOW_SECONDS),
      ),
    );
    const refused = await store.increment(
      'tenant-1:user-1:autosuggest',
      WINDOW_SECONDS,
    );
    expect(refused.count).toBe(LIMIT + 1);

    // Move the clock past the window. The counter must reset to a fresh window.
    now += WINDOW_SECONDS * 1000 + 1;

    const afterWindow = await store.increment(
      'tenant-1:user-1:autosuggest',
      WINDOW_SECONDS,
    );
    expect(afterWindow.count).toBe(1);
    expect(afterWindow.windowRemainingSeconds).toBe(WINDOW_SECONDS);
  });

  it('a refused call reports a retry value inside the current window', async () => {
    await Promise.all(
      Array.from({ length: LIMIT }, () =>
        store.increment('tenant-1:user-1:autosuggest', WINDOW_SECONDS),
      ),
    );
    // 20 seconds into the window, the 61st call is refused.
    now += 20_000;
    const refused = await store.increment(
      'tenant-1:user-1:autosuggest',
      WINDOW_SECONDS,
    );

    expect(refused.count).toBe(LIMIT + 1);
    expect(refused.windowRemainingSeconds).toBeGreaterThanOrEqual(1);
    expect(refused.windowRemainingSeconds).toBeLessThanOrEqual(WINDOW_SECONDS);
    expect(refused.windowRemainingSeconds).toBe(40);
  });

  it('leaves no per-key chain behind once the concurrent work has finished', async () => {
    await Promise.all([
      Promise.all(
        Array.from({ length: 50 }, () =>
          store.increment('tenant-1:user-A:autosuggest', WINDOW_SECONDS),
        ),
      ),
      Promise.all(
        Array.from({ length: 50 }, () =>
          store.increment('tenant-1:user-B:autosuggest', WINDOW_SECONDS),
        ),
      ),
    ]);
    // Let the cleanup callbacks scheduled after the last call run.
    await new Promise((resolve) => setImmediate(resolve));

    expect(store['chains'].size).toBe(0);
  });

  it('a rejected cache call does not wedge later calls for the same key', async () => {
    const realGet = cache.get.bind(cache);
    const getSpy = jest
      .spyOn(cache, 'get')
      .mockRejectedValueOnce(new Error('cache unavailable'));

    await expect(
      store.increment('tenant-1:user-1:autosuggest', WINDOW_SECONDS),
    ).rejects.toThrow('cache unavailable');

    getSpy.mockImplementation(realGet);
    const next = await store.increment(
      'tenant-1:user-1:autosuggest',
      WINDOW_SECONDS,
    );
    expect(next.count).toBe(1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(store['chains'].size).toBe(0);
  });
});
