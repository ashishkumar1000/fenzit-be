import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  MockPlacesProvider,
  SIMULATE_PROVIDER_ERROR_QUERY,
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
});
