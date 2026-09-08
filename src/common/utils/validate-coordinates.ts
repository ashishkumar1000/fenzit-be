/**
 * Shared coordinate-range guard for service interfaces that accept optional
 * latitude/longitude. Defense-in-depth for DIRECT service callers: the DTO
 * validators only run at the HTTP edge, and these methods are callable from
 * any module with a plain input object that never touches them. (The DTO
 * layer itself does reject NaN/out-of-range values — this mirrors the guard
 * in PlacesService.resolve for the no-pipe path.)
 */
export function hasInvalidCoordinates(
  latitude: number | undefined,
  longitude: number | undefined,
): boolean {
  const isInvalid = (value: number | undefined, min: number, max: number) =>
    value !== undefined &&
    (!Number.isFinite(value) || value < min || value > max);
  return isInvalid(latitude, -90, 90) || isInvalid(longitude, -180, 180);
}
