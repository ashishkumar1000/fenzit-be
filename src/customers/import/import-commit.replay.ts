import {
  ConflictException,
  InternalServerErrorException,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ErrorCode } from '../../common/enums/error-code.enum';
import {
  IMPORT_COMMIT_SCOPE,
  ImportCommitResponse,
} from './import-commit.types';

const logger = new Logger('ImportCommitReplay');
/** A run still "in progress" after this long is treated as abandoned. */
const STALE_CLAIM_MS = 10 * 60 * 1000;

/**
 * What idempotency_log holds for one key. Both states keep the request hash,
 * so a reused key with a different sheet is refused instead of replayed.
 */
interface StoredClaim {
  requestHash: string;
  /** Identifies the run that owns the claim; only that run may finish or release it. */
  claimToken: string;
  response?: ImportCommitResponse; // absent while the run is in progress
}

interface ClaimRow {
  id: string;
  created_at: string;
  response_body: unknown;
}

export type ImportClaim =
  | { kind: 'claimed'; claimToken: string }
  | { kind: 'replay'; response: ImportCommitResponse };

/** Fingerprint of what the staff member sent. Same key + same sheet = same run. */
export function hashImportRequest(dto: {
  rows: unknown;
  defaultCountryCode?: unknown;
  fileName?: unknown;
}): string {
  return createHash('sha256')
    .update(
      stableStringify({
        rows: dto.rows,
        defaultCountryCode: dto.defaultCountryCode ?? null,
        fileName: dto.fileName ?? null,
      }),
    )
    .digest('hex');
}

/**
 * JSON with object keys sorted at every depth, so the same sheet hashes the
 * same however its keys were ordered when it was sent.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
      );
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Claims the key BEFORE any write, so two requests with the same key cannot
 * both run the import. Outcomes:
 *   - no live claim               -> claimed (this request runs the import)
 *   - finished, same sheet        -> replay (return the first answer, write nothing)
 *   - finished, different sheet   -> 422 key reused
 *   - running, different sheet    -> 422 key reused (unless it is stale)
 *   - running, same sheet, fresh  -> 409 in progress
 *   - running, stale (> 10 min)   -> taken over and claimed
 * A finished answer is kept for good: it is never taken over, so a retry
 * after any delay replays it instead of writing a second batch and audit.
 */
export async function claimImportKey(
  admin: SupabaseClient,
  tenantId: string,
  key: string,
  requestHash: string,
  now: number = Date.now(),
): Promise<ImportClaim> {
  const row = await readClaim(admin, tenantId, key);
  const claimToken = randomUUID();
  if (!row) {
    await insertClaim(admin, tenantId, key, requestHash, claimToken, now);
    return { kind: 'claimed', claimToken };
  }

  const stored = readStored(row);
  const finished = stored.response !== undefined;
  const age = now - Date.parse(row.created_at);

  if (!finished && age >= STALE_CLAIM_MS) {
    await takeOver(admin, tenantId, key, row.id, requestHash, claimToken, now);
    return { kind: 'claimed', claimToken };
  }
  if (stored.requestHash !== requestHash) throw keyReused();
  if (!finished || !stored.response) throw inProgress();
  return { kind: 'replay', response: stored.response };
}

/**
 * Keeps the running claim fresh while rows are written, so a slow but live
 * run is never taken over. Only the owning run (claimToken) can refresh it.
 * Never throws: a missed refresh only means the claim may go stale sooner.
 */
export async function touchImportKey(
  admin: SupabaseClient,
  tenantId: string,
  key: string,
  claimToken: string,
  now: number = Date.now(),
): Promise<void> {
  try {
    const { error } = await admin
      .from('idempotency_log')
      .update({ created_at: new Date(now).toISOString() })
      .eq('key', key)
      .eq('tenant_id', tenantId)
      .eq('scope', IMPORT_COMMIT_SCOPE)
      .eq('response_body->>claimToken', claimToken);
    if (error) {
      logger.warn(
        `Failed to refresh idempotency_log claim (code=${error.code ?? 'none'})`,
      );
    }
  } catch {
    logger.warn('Failed to refresh idempotency_log claim');
  }
}

/** Stores the answer once the rows, batch and audit are written. */
export async function completeImportKey(
  admin: SupabaseClient,
  tenantId: string,
  key: string,
  claim: { requestHash: string; claimToken: string },
  response: ImportCommitResponse,
): Promise<void> {
  // Never throws: the rows are already written, so the caller still gets the
  // answer. A failure leaves the claim running until it goes stale.
  let error: { code?: string } | null;
  try {
    ({ error } = await admin
      .from('idempotency_log')
      .update({ response_body: { ...claim, response } })
      .eq('key', key)
      .eq('tenant_id', tenantId)
      .eq('scope', IMPORT_COMMIT_SCOPE)
      .eq('response_body->>claimToken', claim.claimToken));
  } catch {
    error = { code: 'network' };
  }
  if (error) {
    logger.error(
      `Failed to store idempotency_log (code=${error.code ?? 'none'})`,
    );
  }
}

/**
 * Lets a retry run again when the import failed before any row was written.
 * Expires the claim by backdating it, so the next request takes it over.
 */
export async function releaseImportKey(
  admin: SupabaseClient,
  tenantId: string,
  key: string,
  claimToken: string,
): Promise<void> {
  try {
    await admin
      .from('idempotency_log')
      .update({ created_at: new Date(0).toISOString() })
      .eq('key', key)
      .eq('tenant_id', tenantId)
      .eq('scope', IMPORT_COMMIT_SCOPE)
      .eq('response_body->>claimToken', claimToken);
  } catch {
    logger.error('Failed to release idempotency_log claim');
  }
}

/** Reads the stored claim. A malformed row is a server fault, never a guess. */
function readStored(row: ClaimRow): StoredClaim {
  const body = row.response_body as Partial<StoredClaim> | null;
  if (
    body === null ||
    typeof body !== 'object' ||
    typeof body.requestHash !== 'string'
  ) {
    logger.error(`idempotency_log row ${row.id} has an unreadable claim`);
    throw claimFailed();
  }
  return body as StoredClaim;
}

async function readClaim(
  admin: SupabaseClient,
  tenantId: string,
  key: string,
): Promise<ClaimRow | null> {
  // A network fault rejects instead of returning an error. Both shapes stop
  // the request with the same stated 500 (the import has not run yet).
  let page: { data: ClaimRow | null; error: { code?: string } | null };
  try {
    page = await admin
      .from('idempotency_log')
      .select('id, created_at, response_body')
      .eq('key', key)
      .eq('tenant_id', tenantId)
      .eq('scope', IMPORT_COMMIT_SCOPE)
      .maybeSingle<ClaimRow>();
  } catch {
    page = { data: null, error: { code: 'network' } };
  }
  if (page.error) {
    logger.error(
      `Failed to read idempotency_log (code=${page.error.code ?? 'none'})`,
    );
    throw new InternalServerErrorException({
      error_code: ErrorCode.INTERNAL_SERVER_ERROR,
      message: 'Failed to check for an earlier import with this request ID',
    });
  }
  return page.data;
}

async function insertClaim(
  admin: SupabaseClient,
  tenantId: string,
  key: string,
  requestHash: string,
  claimToken: string,
  now: number,
): Promise<void> {
  let error: { code?: string } | null;
  try {
    ({ error } = await admin.from('idempotency_log').insert({
      key,
      tenant_id: tenantId,
      scope: IMPORT_COMMIT_SCOPE,
      response_body: { requestHash, claimToken } satisfies StoredClaim,
      created_at: new Date(now).toISOString(),
    }));
  } catch {
    error = { code: 'network' };
  }
  if (error?.code === '23505') throw inProgress(); // a concurrent request won
  if (error) {
    logger.error(
      `Failed to claim idempotency_log (code=${error.code ?? 'none'})`,
    );
    throw claimFailed();
  }
}

/** Takes over a stale running claim, only if it is still that old. */
async function takeOver(
  admin: SupabaseClient,
  tenantId: string,
  key: string,
  id: string,
  requestHash: string,
  claimToken: string,
  now: number,
): Promise<void> {
  const cutoff = new Date(now - STALE_CLAIM_MS).toISOString();
  let page: { data: { id: string } | null; error: { code?: string } | null };
  try {
    page = await admin
      .from('idempotency_log')
      .update({
        response_body: { requestHash, claimToken } satisfies StoredClaim,
        created_at: new Date(now).toISOString(),
      })
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .eq('key', key)
      .lt('created_at', cutoff)
      .maybeSingle<{ id: string }>();
  } catch {
    page = { data: null, error: { code: 'network' } };
  }
  if (page.error) throw claimFailed();
  if (!page.data) throw inProgress(); // someone else took it first
}

function inProgress(): ConflictException {
  return new ConflictException({
    error_code: ErrorCode.IMPORT_IN_PROGRESS,
    message:
      'An import with this request ID is still being saved. Wait a few minutes, then check the customer list before you try again.',
  });
}

function keyReused(): UnprocessableEntityException {
  return new UnprocessableEntityException({
    error_code: ErrorCode.IDEMPOTENCY_KEY_REUSED,
    message:
      'This request ID was already used for a different sheet. Start a new upload to import this sheet.',
  });
}

function claimFailed(): InternalServerErrorException {
  return new InternalServerErrorException({
    error_code: ErrorCode.INTERNAL_SERVER_ERROR,
    message: 'Failed to check for an earlier import with this request ID',
  });
}
