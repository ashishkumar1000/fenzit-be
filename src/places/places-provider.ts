/** IN-only for now — the only region the mock (and initial Google rollout) supports. */
export type PlacesRegion = 'IN';

export interface PlaceSuggestion {
  placeId: string;
  text: string;
}

/**
 * Resolved place detail returned by `resolve()` (Story 1.2). `city`/`pincode`
 * are `null` when the underlying place lacks them — never omitted or `''`.
 * `latitude`/`longitude` are guaranteed real numbers whenever `resolve()`
 * resolves successfully; a provider that cannot obtain coordinates must throw
 * instead of returning a null/placeholder coordinate.
 */
export interface ResolvedPlace {
  placeId: string;
  formattedAddress: string;
  city: string | null;
  pincode: string | null;
  latitude: number;
  longitude: number;
}

/**
 * Address resolved from raw coordinates (Story 15.4's map-picker pin row).
 * Every field is `null` when the point has no address (open water, or an
 * upstream 200 with zero results) — a "not found" point is a success with
 * the null-address shape, never a throw; callers fall back to showing the
 * raw coordinates. Only a transport/provider-level failure throws.
 */
export interface ReverseGeocodedAddress {
  formattedAddress: string | null;
  city: string | null;
  pincode: string | null;
}

/**
 * Abstract address-autosuggest provider. `places.module.ts` binds
 * `GooglePlacesProvider` outside tests and `MockPlacesProvider` in tests;
 * both slot in behind this same signature with zero controller/service
 * changes.
 */
export abstract class PlacesProvider {
  abstract autosuggest(
    query: string,
    sessionToken: string,
    region: PlacesRegion,
  ): Promise<PlaceSuggestion[]>;

  abstract resolve(
    placeId: string,
    sessionToken: string,
    region: PlacesRegion,
  ): Promise<ResolvedPlace>;

  /**
   * Reverse geocode raw coordinates into an address (Story 15.4). No
   * session token — Google's Geocoding API (the only Google surface with a
   * server-side reverse lookup) is billed per call, so abuse is bounded by
   * the per-endpoint rate limit in `PlacesService` instead.
   */
  abstract reverseGeocode(
    latitude: number,
    longitude: number,
  ): Promise<ReverseGeocodedAddress>;
}
