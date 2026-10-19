import { DEFAULT_CORS_ORIGIN, parseCorsOrigins } from './cors-origins';

describe('parseCorsOrigins', () => {
  describe('defaults', () => {
    it('falls back to the production web origin when unset', () => {
      expect(parseCorsOrigins(undefined)).toEqual([DEFAULT_CORS_ORIGIN]);
    });

    it('falls back to the production web origin when empty or blank', () => {
      expect(parseCorsOrigins('')).toEqual([DEFAULT_CORS_ORIGIN]);
      expect(parseCorsOrigins('   ')).toEqual([DEFAULT_CORS_ORIGIN]);
    });

    it('defaults to https://fenzit.com only, with no localhost', () => {
      expect(DEFAULT_CORS_ORIGIN).toBe('https://fenzit.com');
    });
  });

  describe('valid lists', () => {
    it('accepts a single https origin', () => {
      expect(parseCorsOrigins('https://fenzit.com')).toEqual([
        'https://fenzit.com',
      ]);
    });

    it('accepts an http origin with a port (local dev)', () => {
      expect(parseCorsOrigins('http://localhost:5173')).toEqual([
        'http://localhost:5173',
      ]);
    });

    it('splits a comma-separated list and keeps the order', () => {
      expect(
        parseCorsOrigins('https://fenzit.com,http://localhost:5173'),
      ).toEqual(['https://fenzit.com', 'http://localhost:5173']);
    });

    it('trims spaces around each entry and drops empty entries', () => {
      expect(
        parseCorsOrigins('  https://fenzit.com ,, http://localhost:5173 ,'),
      ).toEqual(['https://fenzit.com', 'http://localhost:5173']);
    });

    it('keeps a duplicate entry as given (harmless to the policy)', () => {
      expect(parseCorsOrigins('https://fenzit.com,https://fenzit.com')).toEqual(
        ['https://fenzit.com', 'https://fenzit.com'],
      );
    });
  });

  describe('rejected values (fail fast at boot)', () => {
    it.each([
      ['a wildcard', '*'],
      ['a bare host with no scheme', 'fenzit.com'],
      ['a trailing slash', 'https://fenzit.com/'],
      ['a path', 'https://fenzit.com/app'],
      ['a query string', 'https://fenzit.com?x=1'],
      ['a fragment', 'https://fenzit.com#top'],
      ['a non-http scheme', 'ftp://fenzit.com'],
      ['a javascript: URL', 'javascript:alert(1)'],
      ['the literal string null', 'null'],
      ['an unparseable value', 'https://'],
      ['a wildcard subdomain', 'https://*.fenzit.com'],
      ['a trailing space inside the origin', 'https://fenzit .com'],
    ])('throws for %s', (_label, value) => {
      expect(() => parseCorsOrigins(value)).toThrow(/CORS_ALLOWED_ORIGINS/);
    });

    it('throws when one bad entry is mixed in with good ones', () => {
      expect(() =>
        parseCorsOrigins('https://fenzit.com,https://evil.example/path'),
      ).toThrow(/https:\/\/evil\.example\/path/);
    });

    it('rejects an uppercase origin, because the browser sends it lowercase', () => {
      expect(() => parseCorsOrigins('HTTPS://FENZIT.COM')).toThrow();
    });

    it('rejects an explicit default port, which the browser never sends', () => {
      expect(() => parseCorsOrigins('https://fenzit.com:443')).toThrow();
    });
  });
});
