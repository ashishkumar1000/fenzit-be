import { BadRequestException } from '@nestjs/common';
import { encodeCursor, decodeCursor } from './cursor.util';

describe('cursor.util', () => {
  const UUID = '00000000-0000-4000-8000-000000000001';
  const ISO = '2026-06-21T00:00:00Z';

  it('round-trips a valid id + createdAt', () => {
    const cursor = encodeCursor(UUID, ISO);
    expect(decodeCursor(cursor)).toEqual({ id: UUID, createdAt: ISO });
  });

  it('accepts a Date createdAt and encodes it as ISO', () => {
    const date = new Date('2026-06-21T12:34:56.000Z');
    const decoded = decodeCursor(encodeCursor(UUID, date));
    expect(decoded.createdAt).toBe(date.toISOString());
  });

  it('throws 400 on non-base64 / non-JSON input', () => {
    expect(() => decodeCursor('not-a-valid-cursor')).toThrow(
      BadRequestException,
    );
  });

  it('throws 400 when required fields are missing', () => {
    const cursor = Buffer.from(JSON.stringify({ id: UUID })).toString(
      'base64url',
    );
    expect(() => decodeCursor(cursor)).toThrow(BadRequestException);
  });

  it('throws 400 when id is not a UUID (rejects injection payloads)', () => {
    const forged = Buffer.from(
      JSON.stringify({ id: 'x),or(tenant_id.neq.0', createdAt: ISO }),
    ).toString('base64url');
    expect(() => decodeCursor(forged)).toThrow(BadRequestException);
  });

  it('throws 400 when createdAt is not a valid timestamp', () => {
    const forged = Buffer.from(
      JSON.stringify({ id: UUID, createdAt: 'and(1.eq.1)' }),
    ).toString('base64url');
    expect(() => decodeCursor(forged)).toThrow(BadRequestException);
  });
});
