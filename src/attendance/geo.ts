/**
 * Haversine great-circle distance in metres (16-1). The server-side
 * distance the PRD requires ("the server computes the distance… the server
 * makes the decision") — the device never sends one. Pure and synchronous
 * so the day-context and unit tests need no DB.
 */

const EARTH_RADIUS_M = 6_371_008.8; // IUGG mean radius

export function haversineDistanceM(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}
