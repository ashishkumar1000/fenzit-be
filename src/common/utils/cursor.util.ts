import { BadRequestException, Logger } from '@nestjs/common';
import { ErrorCode } from '../enums/error-code.enum';

/**
 * Endpoint a cursor was minted for. Encoded into the cursor payload so a
 * cursor from one paginated endpoint can never be replayed against another
 * (their timestamps mean different columns — e.g. jobs-list keys on
 * created_at, customer-history on scheduled_start — and a cross-replay
 * would silently return the wrong page with a 200).
 */
export type CursorScope =
  | 'customers-list'
  | 'customer-history'
  | 'jobs-list'
  | 'profile-jobs';

interface CursorPayload {
  id: string;
  createdAt: string;
  scope: CursorScope;
}

const logger = new Logger('Cursor');

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// ISO-8601 timestamp charset only — excludes PostgREST-structural chars (`,` `(` `)`)
// and the letters used in operator keywords, so a decoded cursor can never inject
// filter syntax when interpolated into a PostgREST `.or()` string.
const TIMESTAMP_RE = /^[0-9T:.+\-Z ]+$/;

export function encodeCursor(
  id: string,
  createdAt: Date | string,
  scope: CursorScope,
): string {
  const payload: CursorPayload = {
    id,
    createdAt: createdAt instanceof Date ? createdAt.toISOString() : createdAt,
    scope,
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

/**
 * Rejects an opaque cursor with a 400. The client-facing body stays generic
 * ('Invalid cursor'); the specific reason is logged so a bad cursor can be
 * diagnosed from server logs alone.
 */
function rejectCursor(reason: string, expectedScope?: CursorScope): never {
  logger.warn(
    `Rejected cursor: ${reason} (expected scope: ${expectedScope ?? 'any'})`,
  );
  throw new BadRequestException({
    error_code: ErrorCode.VALIDATION_ERROR,
    message: 'Invalid cursor',
  });
}

/**
 * Decodes and validates an opaque cursor. When `expectedScope` is given, the
 * cursor must carry exactly that scope — a cursor minted for a different
 * endpoint (or an old cursor with no scope) is rejected with a 400. Every
 * endpoint should pass its own scope; omitting it skips the scope check
 * (used by tests decoding payloads without a specific endpoint in mind).
 */
export function decodeCursor(
  cursor: string,
  expectedScope?: CursorScope,
): CursorPayload {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf-8');
  } catch {
    rejectCursor('not valid base64url', expectedScope);
  }

  let parsed: Partial<CursorPayload>;
  try {
    parsed = JSON.parse(decoded) as Partial<CursorPayload>;
  } catch {
    rejectCursor('payload is not valid JSON', expectedScope);
  }

  if (typeof parsed.id !== 'string' || typeof parsed.createdAt !== 'string') {
    rejectCursor('missing required fields (id, createdAt)', expectedScope);
  }

  if (
    !UUID_RE.test(parsed.id) ||
    !TIMESTAMP_RE.test(parsed.createdAt) ||
    Number.isNaN(Date.parse(parsed.createdAt))
  ) {
    rejectCursor(
      'malformed field format (id must be a UUID, createdAt an ISO-8601 timestamp)',
      expectedScope,
    );
  }

  if (expectedScope !== undefined && parsed.scope !== expectedScope) {
    rejectCursor(
      `scope mismatch — cursor carries '${String(parsed.scope)}'`,
      expectedScope,
    );
  }

  return parsed as CursorPayload;
}