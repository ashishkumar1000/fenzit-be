import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PlacesProvider,
  PlaceSuggestion,
  PlacesRegion,
  ResolvedPlace,
  ReverseGeocodedAddress,
} from './places-provider';

const PLACES_API_BASE_URL = 'https://places.googleapis.com/v1';
// Legacy Geocoding API (not Places New) — the only Google surface with a
// server-side reverse lookup. Uses the same server-side key as the Places
// calls (the key's project must have the Geocoding API enabled).
const GEOCODING_API_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const REQUEST_TIMEOUT_MS = 4000;

// Essentials tier only (already approved in Story 1.2) — never add
// `displayName`/Pro-tier fields, which would silently upgrade the whole call
// to Pro-tier billing.
const RESOLVE_FIELD_MASK =
  'id,formattedAddress,location,addressComponents,postalAddress';

/** Raw Autocomplete (New) `suggestions[]` entry shape — Google's own nested
 * shape, never exposed to callers. See `deferred-work.md` (2026-09-05
 * manual verification) for the confirmed contract. */
interface GoogleAutocompleteSuggestion {
  placePrediction?: {
    placeId?: string;
    text?: {
      text?: string;
    };
  };
}

interface GoogleAutocompleteResponse {
  suggestions?: GoogleAutocompleteSuggestion[];
}

interface GoogleAddressComponent {
  longText?: string;
  shortText?: string;
  types?: string[];
}

/** Raw Place Details (New) response shape, Essentials-tier field mask only. */
interface GooglePlaceDetailsResponse {
  id?: string;
  formattedAddress?: string;
  location?: {
    latitude?: number;
    longitude?: number;
  };
  addressComponents?: GoogleAddressComponent[];
  postalAddress?: {
    postalCode?: string;
  };
}

/**
 * Legacy Geocoding API component — a DIFFERENT wire shape than the Places
 * (New) `addressComponents` above: snake_case `long_name`/`short_name`.
 */
interface GoogleGeocodeAddressComponent {
  long_name?: string;
  types?: string[];
}

interface GoogleGeocodeResult {
  formatted_address?: string;
  address_components?: GoogleGeocodeAddressComponent[];
}

/** Legacy Geocoding API response. `status` is 'OK' | 'ZERO_RESULTS' | … */
interface GoogleGeocodeResponse {
  status?: string;
  // Human-readable denial reason (e.g. "API key not authorized…", "…API is
  // disabled…") — logged with the thrown error, never surfaced to clients.
  error_message?: string;
  results?: GoogleGeocodeResult[];
}

/**
 * Live Google Places (New) integration. Bound as `PlacesProvider` for every
 * environment except the Jest-driven test/e2e suite (`NODE_ENV=test`, see
 * places.module.ts), which keeps resolving `MockPlacesProvider`.
 *
 * The API key is sent only via the `X-Goog-Api-Key` header — never logged,
 * never in a query string or response body.
 */
@Injectable()
export class GooglePlacesProvider extends PlacesProvider {
  private readonly logger = new Logger(GooglePlacesProvider.name);
  private readonly apiKey: string;

  constructor(private readonly configService: ConfigService) {
    super();
    this.apiKey = this.configService.getOrThrow<string>(
      'GOOGLE_PLACES_API_KEY',
    );
  }

  async autosuggest(
    query: string,
    sessionToken: string,
    region: PlacesRegion,
  ): Promise<PlaceSuggestion[]> {
    const response = await fetch(`${PLACES_API_BASE_URL}/places:autocomplete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': this.apiKey,
      },
      body: JSON.stringify({
        input: query,
        sessionToken,
        includedRegionCodes: [region],
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(
        `Google Places autocomplete request failed with status ${response.status}`,
      );
    }

    const body = (await response.json()) as GoogleAutocompleteResponse;

    return (body.suggestions ?? []).flatMap((suggestion) => {
      const placeId = suggestion.placePrediction?.placeId;
      const text = suggestion.placePrediction?.text?.text;

      if (!placeId || !text) {
        return [];
      }

      return [{ placeId, text }];
    });
  }

  async resolve(
    placeId: string,
    sessionToken: string,
    // Region is not a Place Details (New) request parameter — Google
    // resolves that endpoint purely from the placeId itself. Part of the
    // PlacesProvider contract for parity with autosuggest().
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _region: PlacesRegion,
  ): Promise<ResolvedPlace> {
    const url = new URL(
      `${PLACES_API_BASE_URL}/places/${encodeURIComponent(placeId)}`,
    );
    url.searchParams.set('sessionToken', sessionToken);

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Goog-Api-Key': this.apiKey,
        'X-Goog-FieldMask': RESOLVE_FIELD_MASK,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(
        `Google Places details request failed with status ${response.status}`,
      );
    }

    const body = (await response.json()) as GooglePlaceDetailsResponse;

    const { latitude, longitude } = body.location ?? {};
    if (typeof latitude !== 'number' || typeof longitude !== 'number') {
      // A valid place with no location must never surface as a
      // null-coordinate success — same contract MockPlacesProvider honors.
      throw new Error(
        `Google Places details response for placeId ${placeId} is missing location`,
      );
    }

    const cityComponent = (body.addressComponents ?? []).find((component) =>
      component.types?.includes('locality'),
    );

    return {
      placeId: body.id ?? placeId,
      formattedAddress: body.formattedAddress ?? '',
      // postalAddress can be entirely absent for a broader/less-specific
      // place (confirmed during manual verification, not just missing
      // postalCode) — never assume it exists. `|| null` (not `??`) so an
      // empty-string value also normalizes to null, per the `ResolvedPlace`
      // contract ("never omitted or ''").
      pincode: body.postalAddress?.postalCode || null,
      city: cityComponent?.longText || null,
      latitude,
      longitude,
    };
  }

  /**
   * Legacy Geocoding API reverse lookup — Places (New) has no reverse
   * surface. No `sessionToken` (this API has none; billed per call, bounded
   * by the per-endpoint rate limit in PlacesService). A 200 with zero
   * results resolves to the null-address shape ("no address here"), never a
   * throw — only transport/provider-level failures throw, which
   * PlacesService maps to the documented 502.
   */
  async reverseGeocode(
    latitude: number,
    longitude: number,
  ): Promise<ReverseGeocodedAddress> {
    const url = new URL(GEOCODING_API_URL);
    url.searchParams.set('latlng', `${latitude},${longitude}`);
    // Legacy web services authenticate via the `key` query parameter — they
    // do NOT honour the `X-Goog-Api-Key` header (Places New's convention;
    // verified live 2026-09-26: header-only auth returned REQUEST_DENIED
    // "You must use an API key"). The URL is never logged, so the key stays
    // out of logs and responses alike.
    url.searchParams.set('key', this.apiKey);

    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(
        `Google Geocoding request failed with status ${response.status}`,
      );
    }

    const body = (await response.json()) as GoogleGeocodeResponse;

    if (body.status === 'ZERO_RESULTS') {
      return { formattedAddress: null, city: null, pincode: null };
    }
    if (body.status !== 'OK') {
      throw new Error(
        `Google Geocoding reverse lookup returned status ${body.status}` +
          (body.error_message ? `: ${body.error_message}` : ''),
      );
    }

    const result = body.results?.[0];
    if (!result) {
      // Defensive: an OK status with an empty results array reads the same
      // as ZERO_RESULTS — never an undefined-property crash.
      return { formattedAddress: null, city: null, pincode: null };
    }

    const components = result.address_components ?? [];
    const cityComponent = components.find((component) =>
      component.types?.includes('locality'),
    );
    const pincodeComponent = components.find((component) =>
      component.types?.includes('postal_code'),
    );

    return {
      // Same `|| null` normalization as resolve(): an empty-string value
      // normalizes to null, per the ReverseGeocodedAddress contract.
      formattedAddress: result.formatted_address || null,
      city: cityComponent?.long_name || null,
      pincode: pincodeComponent?.long_name || null,
    };
  }
}
