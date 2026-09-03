import { BadRequestException } from '@nestjs/common';
import { encodeCursor, decodeCursor, CursorScope } from './cursor.util';

describe('cursor.util', () => {
  const UUID = '00000000-0000-4000-8000-000000000001';
  const ISO = '2026-06-21T00:00:00Z';
  const SCOPE: CursorScope = 'jobs-list';

  it('round-trips a valid id + createdAt + scope', () => {
    const cursor = encodeCursor(UUID, ISO, SCOPE);
    expect(decodeCursor(cursor, SCOPE)).toEqual({
      id: UUID,
      createdAt: ISO,
      scope: SCOPE,
    });
  });

  it('accepts a Date createdAt and encodes it as ISO', () => {
    const date = new Date('2026-06-21T12:34:56.000Z');
    const decoded = decodeCursor(
      encodeCursor(UUID, date, 'customers-list'),
      'customers-list',
    );
    expect(decoded.createdAt).toBe(date.toISOString());
  });

  it('throws 400 on non-base64 / non-JSON input', () => {
    expect(() => decodeCursor('not-a-valid-cursor', SCOPE)).toThrow(
      BadRequestException,
    );
  });

  it('throws 400 when required fields are missing', () => {
    const cursor = Buffer.from(JSON.stringify({ id: UUID })).toString(
      'base64url',
    );
    expect(() => decodeCursor(cursor, SCOPE)).toThrow(BadRequestException);
  });

  it('throws 400 when id is not a UUID (rejects injection payloads)', () => {
    const forged = Buffer.from(
      JSON.stringify({ id: 'x),or(tenant_id.neq.0', createdAt: ISO, scope: SCOPE }),
    ).toString('base64url');
    expect(() => decodeCursor(forged, SCOPE)).toThrow(BadRequestException);
  });

  it('throws 400 when createdAt is not a valid timestamp', () => {
    const forged = Buffer.from(
      JSON.stringify({ id: UUID, createdAt: 'and(1.eq.1)', scope: SCOPE }),
    ).toString('base64url');
    expect(() => decodeCursor(forged, SCOPE)).toThrow(BadRequestException);
  });

  it('throws 400 when the cursor was minted for a different endpoint scope', () => {
    // a jobs-list cursor replayed against the customer-history endpoint
    const cursor = encodeCursor(UUID, ISO, 'jobs-list');
    expect(() => decodeCursor(cursor, 'customer-history')).toThrow(
      BadRequestException,
    );
  });

  it('throws 400 when the cursor carries no scope but one is expected', () => {
    // pre-scope cursor shape: {id, createdAt} only
    const legacy = Buffer.from(
      JSON.stringify({ id: UUID, createdAt: ISO }),
    ).toString('base64url');
    expect(() => decodeCursor(legacy, SCOPE)).toThrow(BadRequestException);
  });

  it('skips the scope check when no expected scope is given', () => {
    const cursor = encodeCursor(UUID, ISO, 'jobs-list');
    expect(() => decodeCursor(cursor)).not.toThrow();
  });
});