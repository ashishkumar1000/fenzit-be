import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PlacesProvider,
  PlaceSuggestion,
  PlacesRegion,
} from './places-provider';

/**
 * Sentinel query value the mock recognizes to simulate a provider-level
 * failure, exercising the same 502 error-mapping path a real Google API
 * outage would hit (see PlacesService). Only honored outside production
 * (see autosuggest() below) so a real Owner typing this literal string into
 * an address field in production never triggers a fake upstream failure —
 * MockPlacesProvider is the only bound provider in every environment today.
 */
export const SIMULATE_PROVIDER_ERROR_QUERY = '__simulate_provider_error__';

/** Deterministic fixtures keyed by a lowercase substring of the query. */
const FIXTURE_SUGGESTIONS: Record<string, PlaceSuggestion[]> = {
  'andheri w': [
    {
      placeId: 'mock-place-andheri-west-1',
      text: 'Andheri West, Mumbai, Maharashtra, India',
    },
    {
      placeId: 'mock-place-andheri-west-2',
      text: 'Andheri West Station Road, Mumbai, Maharashtra, India',
    },
  ],
  bandra: [
    {
      placeId: 'mock-place-bandra-1',
      text: 'Bandra West, Mumbai, Maharashtra, India',
    },
  ],
  koramangala: [
    {
      placeId: 'mock-place-koramangala-1',
      text: 'Koramangala, Bengaluru, Karnataka, India',
    },
  ],
};

@Injectable()
export class MockPlacesProvider extends PlacesProvider {
  constructor(private readonly configService: ConfigService) {
    super();
    // Read (but do not use) GOOGLE_PLACES_API_KEY so the env-read path a
    // future GooglePlacesProvider depends on is already exercised at
    // construction time. Joi already fails boot if it's unset; this proves
    // the ConfigService.getOrThrow contract too.
    this.configService.getOrThrow<string>('GOOGLE_PLACES_API_KEY');
  }

  async autosuggest(
    query: string,
    // sessionToken/region are part of the PlacesProvider contract (Google
    // session-billing + region-restricted search) but unused by this
    // deterministic mock.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _sessionToken: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _region: PlacesRegion,
  ): Promise<PlaceSuggestion[]> {
    const normalized = query.trim().toLowerCase();

    if (
      process.env['NODE_ENV'] !== 'production' &&
      normalized === SIMULATE_PROVIDER_ERROR_QUERY
    ) {
      throw new Error('Simulated Places provider failure');
    }

    const matchKey = Object.keys(FIXTURE_SUGGESTIONS).find((key) =>
      normalized.includes(key),
    );

    return matchKey ? FIXTURE_SUGGESTIONS[matchKey] : [];
  }
}
