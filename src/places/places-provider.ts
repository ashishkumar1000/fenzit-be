/** IN-only for now — the only region the mock (and initial Google rollout) supports. */
export type PlacesRegion = 'IN';

export interface PlaceSuggestion {
  placeId: string;
  text: string;
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
}
