/** Used when CORS_ALLOWED_ORIGINS is unset: the production web app only. */
export const DEFAULT_CORS_ORIGIN = 'https://fenzit.com';

/**
 * Reads CORS_ALLOWED_ORIGINS: a comma-separated list of exact origins
 * (scheme + host + optional port), e.g. `https://fenzit.com,http://localhost:5173`.
 *
 * Throws on anything that is not a bare http(s) origin, so a typo fails the
 * boot instead of silently blocking the web app or widening the policy. A
 * path, a trailing slash, a query, or `*` all fail the check.
 */
export function parseCorsOrigins(raw: string | undefined): string[] {
  const value = raw?.trim() ? raw : DEFAULT_CORS_ORIGIN;
  const origins = value
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  if (origins.length === 0) {
    throw new Error('CORS_ALLOWED_ORIGINS is set but lists no origins');
  }

  for (const origin of origins) {
    if (!isBareOrigin(origin)) {
      throw new Error(
        `CORS_ALLOWED_ORIGINS has an invalid origin "${origin}": use the exact ` +
          'form https://host or http://host:port, with no path or trailing slash',
      );
    }
  }

  return origins;
}

function isBareOrigin(origin: string): boolean {
  // WHATWG URL parsing accepts `*` in a hostname (`https://*.fenzit.com`), and
  // the policy matches exact strings, so such an entry would silently match
  // nothing. Reject it here, where the mistake is visible.
  if (origin.includes('*')) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  // `url.origin` drops any path, query, hash, or trailing slash, so equality
  // with the input proves the input was a bare origin.
  return (
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    url.origin === origin
  );
}
