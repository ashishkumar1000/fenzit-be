import type { FastifyCorsOptions } from '@fastify/cors';
import {
  CORRELATION_HEADER,
  SESSION_HEADER,
} from '../correlation/correlation-headers';

/**
 * Sent by the browser on every mutating call. The BE dedupes on it, so the
 * browser must be allowed to send it. Mirrors the literal used in the
 * controllers (`@Headers('x-idempotency-key')`).
 */
const IDEMPOTENCY_HEADER = 'x-idempotency-key';

/** Request headers the web app sends. Anything else fails the preflight. */
export const CORS_ALLOWED_HEADERS = [
  'Authorization',
  'Content-Type',
  CORRELATION_HEADER,
  SESSION_HEADER,
  IDEMPOTENCY_HEADER,
];

/**
 * Response headers the browser may read. `Retry-After` drives the wait on a
 * 429; the correlation id lets the web app quote it in a bug report.
 */
export const CORS_EXPOSED_HEADERS = ['Retry-After', CORRELATION_HEADER];

/**
 * Every verb a controller declares (GET 45, POST 30, PATCH 6, PUT 5, DELETE 4).
 * Fastify's default list omits PUT, PATCH and DELETE, so a browser preflight
 * for those would be refused.
 */
export const CORS_ALLOWED_METHODS = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
];

/** How long the browser may cache a preflight result: 10 minutes. */
const PREFLIGHT_MAX_AGE_SECONDS = 600;

/**
 * Builds the @fastify/cors options for a fixed list of exact origins.
 *
 * - `origin` is an array of exact strings, so only those origins match. No
 *   wildcard, no reflection of the request's Origin header.
 * - `credentials: false`: the web app sends a bearer token in the
 *   Authorization header, not cookies. Enabling credentials later means
 *   revisiting this policy and the auth design together.
 */
export function buildCorsOptions(
  origins: readonly string[],
): FastifyCorsOptions {
  return {
    origin: [...origins],
    credentials: false,
    allowedHeaders: CORS_ALLOWED_HEADERS,
    methods: CORS_ALLOWED_METHODS,
    exposedHeaders: CORS_EXPOSED_HEADERS,
    maxAge: PREFLIGHT_MAX_AGE_SECONDS,
  };
}
