import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PlacesProvider,
  PlaceSuggestion,
  PlacesRegion,
  ResolvedPlace,
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

/**
 * Sentinel placeId the mock recognizes to simulate a resolve()-level provider
 * failure — same non-production gate and same 502 error-mapping path as
 * SIMULATE_PROVIDER_ERROR_QUERY above, scoped to the resolve endpoint
 * (Story 1.2).
 */
export const SIMULATE_RESOLVE_ERROR_PLACE_ID = '__simulate_resolve_error__';

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

/**
 * Deterministic resolve() fixtures keyed by the exact placeIds already
 * returned by FIXTURE_SUGGESTIONS above, so a full mock autosuggest→resolve
 * round trip is testable without inventing parallel IDs. Plus one extra
 * fixture (`mock-place-koramangala-sublocality-1`) with `pincode`/`city` both
 * `null`, covering the nullable-fields row of the I/O matrix.
 */
const FIXTURE_RESOLVED_PLACES: Record<string, ResolvedPlace> = {
  'mock-place-andheri-west-1': {
    placeId: 'mock-place-andheri-west-1',
    formattedAddress: 'Andheri West, Mumbai, Maharashtra 400058, India',
    city: 'Mumbai',
    pincode: '400058',
    latitude: 19.1364,
    longitude: 72.8296,
  },
  'mock-place-andheri-west-2': {
    placeId: 'mock-place-andheri-west-2',
    formattedAddress:
      'Andheri West Station Road, Mumbai, Maharashtra 400058, India',
    city: 'Mumbai',
    pincode: '400058',
    latitude: 19.1197,
    longitude: 72.8464,
  },
  'mock-place-bandra-1': {
    placeId: 'mock-place-bandra-1',
    formattedAddress: 'Bandra West, Mumbai, Maharashtra 400050, India',
    city: 'Mumbai',
    pincode: '400050',
    latitude: 19.0596,
    longitude: 72.8295,
  },
  'mock-place-koramangala-1': {
    placeId: 'mock-place-koramangala-1',
    formattedAddress: 'Koramangala, Bengaluru, Karnataka 560034, India',
    city: 'Bengaluru',
    pincode: '560034',
    latitude: 12.9352,
    longitude: 77.6245,
  },
  'mock-place-koramangala-sublocality-1': {
    placeId: 'mock-place-koramangala-sublocality-1',
    formattedAddress: 'Koramangala 4th Block, Karnataka, India',
    city: null,
    pincode: null,
    latitude: 12.9352,
    longitude: 77.6245,
  },
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

  async resolve(
    placeId: string,
    // sessionToken/region are part of the PlacesProvider contract (Google
    // session-billing + region-restricted lookup) but unused by this
    // deterministic mock.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _sessionToken: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _region: PlacesRegion,
  ): Promise<ResolvedPlace> {
    if (
      process.env['NODE_ENV'] !== 'production' &&
      placeId === SIMULATE_RESOLVE_ERROR_PLACE_ID
    ) {
      throw new Error('Simulated Places resolve provider failure');
    }

    const hasFixture = Object.prototype.hasOwnProperty.call(
      FIXTURE_RESOLVED_PLACES,
      placeId,
    );
    const fixture = hasFixture ? FIXTURE_RESOLVED_PLACES[placeId] : undefined;
    if (!fixture) {
      // Unrecognized placeId (never issued by autosuggest) — the mock has no
      // way to distinguish "not found" from "upstream failure" any more
      // meaningfully than a real Google error would without deeper parsing,
      // so this maps to the same generic provider-failure path as the
      // sentinel above (see PlacesService.resolve()'s 502 mapping).
      throw new Error(`No resolve fixture found for placeId: ${placeId}`);
    }

    return fixture;
  }
}
