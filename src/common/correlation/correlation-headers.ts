export const CORRELATION_HEADER = 'x-correlation-id';
export const SESSION_HEADER = 'x-session-id';

/** Headers over this length are rejected before the regex (log-injection cap). */
const MAX_HEADER_LENGTH = 64;

/** 8-4-4-4-12 hex, any UUID version, case-insensitive — the FE mints v4. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Accepts only a well-formed, single string UUID. Everything else (missing,
 * array-valued, over-length, injection payloads) is rejected — the caller
 * must fall back to a generated id and never log or echo the raw value.
 */
export function parseCorrelationHeader(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  if (raw.length > MAX_HEADER_LENGTH) {
    return null;
  }
  return UUID_PATTERN.test(raw) ? raw : null;
}
