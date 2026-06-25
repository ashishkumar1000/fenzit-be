import { BadRequestException } from '@nestjs/common';
import { ErrorCode } from '../enums/error-code.enum';

interface CursorPayload {
  id: string;
  createdAt: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// ISO-8601 timestamp charset only — excludes PostgREST-structural chars (`,` `(` `)`)
// and the letters used in operator keywords, so a decoded cursor can never inject
// filter syntax when interpolated into a PostgREST `.or()` string.
const TIMESTAMP_RE = /^[0-9T:.+\-Z ]+$/;

export function encodeCursor(id: string, createdAt: Date | string): string {
  const payload: CursorPayload = {
    id,
    createdAt: createdAt instanceof Date ? createdAt.toISOString() : createdAt,
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeCursor(cursor: string): CursorPayload {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf-8');
  } catch {
    throw new BadRequestException({
      error_code: ErrorCode.VALIDATION_ERROR,
      message: 'Invalid cursor',
    });
  }

  try {
    const parsed = JSON.parse(decoded) as Partial<CursorPayload>;
    if (typeof parsed.id !== 'string' || typeof parsed.createdAt !== 'string') {
      throw new Error('Missing required cursor fields');
    }
    if (
      !UUID_RE.test(parsed.id) ||
      !TIMESTAMP_RE.test(parsed.createdAt) ||
      Number.isNaN(Date.parse(parsed.createdAt))
    ) {
      throw new Error('Malformed cursor field format');
    }
    return parsed as CursorPayload;
  } catch {
    throw new BadRequestException({
      error_code: ErrorCode.VALIDATION_ERROR,
      message: 'Invalid cursor',
    });
  }
}
