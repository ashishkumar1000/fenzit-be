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
 * Abstract address-autosuggest provider. `MockPlacesProvider` is the only
 * binding today (see places.module.ts); a future `GooglePlacesProvider` slots
 * in behind this same signature with zero controller/service changes.
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
}
