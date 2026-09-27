/**
 * Postgres UUID shape — one shared copy for the :id path guards that must
 * reject a malformed id before it reaches PostgREST (a garbage uuid in a
 * param-filtered query 500s as 22P02, not 404). Extracted at the 15-5
 * review: the regex had grown to five file-local copies across
 * offices/holidays/weekly-offs controllers and correlation-headers.
 */
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
