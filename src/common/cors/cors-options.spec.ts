import {
  CORRELATION_HEADER,
  SESSION_HEADER,
} from '../correlation/correlation-headers';
import {
  buildCorsOptions,
  CORS_ALLOWED_HEADERS,
  CORS_EXPOSED_HEADERS,
} from './cors-options';

describe('buildCorsOptions', () => {
  it('matches only the exact origins it was given', () => {
    const options = buildCorsOptions(['https://fenzit.com']);

    expect(options.origin).toEqual(['https://fenzit.com']);
  });

  it('never uses a wildcard or a reflecting origin function', () => {
    const options = buildCorsOptions(['https://fenzit.com']);

    expect(options.origin).not.toBe('*');
    expect(typeof options.origin).not.toBe('function');
    expect(options.origin).not.toContain('*');
  });

  it('copies the origin list so a later change to the input does not widen the policy', () => {
    const input = ['https://fenzit.com'];
    const options = buildCorsOptions(input);

    input.push('https://evil.example');

    expect(options.origin).toEqual(['https://fenzit.com']);
  });

  it('turns credentials off, because auth is a bearer token, not cookies', () => {
    expect(buildCorsOptions(['https://fenzit.com']).credentials).toBe(false);
  });

  it('allows the headers the web app sends, including the idempotency key', () => {
    const allowed = buildCorsOptions(['https://fenzit.com']).allowedHeaders;

    expect(allowed).toEqual(CORS_ALLOWED_HEADERS);
    expect(allowed).toEqual(
      expect.arrayContaining([
        'Authorization',
        'Content-Type',
        CORRELATION_HEADER,
        SESSION_HEADER,
        'x-idempotency-key',
      ]),
    );
  });

  it('exposes Retry-After and the correlation id, and nothing else', () => {
    expect(CORS_EXPOSED_HEADERS).toEqual(['Retry-After', CORRELATION_HEADER]);
  });

  it('allows every verb the controllers declare, including PUT, PATCH and DELETE', () => {
    const methods = buildCorsOptions(['https://fenzit.com']).methods;

    expect(methods).toEqual(
      expect.arrayContaining(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    );
  });

  it('caches the preflight for 10 minutes', () => {
    expect(buildCorsOptions(['https://fenzit.com']).maxAge).toBe(600);
  });
});
