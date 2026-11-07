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
/** Same 24-hour window as the idempotency interceptor. */
const WINDOW_MS = 24 * 60 * 60 * 1000;
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
  response_body: StoredClaim;
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
      JSON.stringify({
        rows: dto.rows,
        defaultCountryCode: dto.defaultCountryCode ?? null,
        fileName: dto.fileName ?? null,
      }),
    )
    .digest('hex');
}

/**
 * Claims the key BEFORE any write, so two requests with the same key cannot
 * both run the import. Outcomes:
 *   - no live claim            -> claimed (this request runs the import)
 *   - finished, same sheet     -> replay (return the first answer, write nothing)
 *   - finished or running, different sheet -> 422 key reused
 *   - still running (< 10 min) -> 409 in progress
 *   - expired / abandoned      -> taken over and claimed
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

  const age = now - Date.parse(row.created_at);
  const finished = row.response_body.response !== undefined;
  const limit = finished ? WINDOW_MS : STALE_CLAIM_MS;

  if (age >= limit) {
    await takeOver(
      admin,
      tenantId,
      key,
      row.id,
      requestHash,
      claimToken,
      now,
      limit,
    );
    return { kind: 'claimed', claimToken };
  }
  if (row.response_body.requestHash !== requestHash) throw keyReused();
  if (!finished || !row.response_body.response) throw inProgress();
  return { kind: 'replay', response: row.response_body.response };
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

/** Takes over an expired or abandoned claim, only if it is still that old. */
async function takeOver(
  admin: SupabaseClient,
  tenantId: string,
  key: string,
  id: string,
  requestHash: string,
  claimToken: string,
  now: number,
  limitMs: number,
): Promise<void> {
  const cutoff = new Date(now - limitMs).toISOString();
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
