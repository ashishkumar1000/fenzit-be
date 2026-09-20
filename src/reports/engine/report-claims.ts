import type { SupabaseClient } from '@supabase/supabase-js';
import { ReportRequestStatus } from '../enums/report-status.enum';
import { ReportRequestRow } from '../report-response.model';

/**
 * Claim + stamp helpers for the report worker (story 12-3) — the de-SP
 * replacement for the dropped claim RPC (migration 51's header comment is
 * the design of record). Every write is a single guarded UPDATE
 * (`where id = ? and status = '<expected>'`), which is atomic in Postgres:
 * exactly one concurrent caller gets the row back, the loser updates zero
 * rows and moves on. No RPC, no extra lock machinery.
 */

/** Deterministic artifact key per request — recovery re-uploads the same one. */
export function reportR2Key(tenantId: string, requestId: string): string {
  return `${tenantId}/reports/${requestId}.pdf`;
}

/**
 * Fresh claim: queued → generating, stamps the lease, bumps attempt_count.
 * `attemptCount` comes from the poll read — the guarded UPDATE is the
 * serialization point, so the winner's read value is always the live one
 * (a loser's update matches zero rows and is discarded). Returns the
 * claimed row, or null when another worker won the race.
 */
export async function claimQueuedReport(
  admin: SupabaseClient,
  requestId: string,
  lockedUntil: string,
  attemptCount: number,
): Promise<ReportRequestRow | null> {
  const { data, error } = await admin
    .from('report_requests')
    .update({
      status: ReportRequestStatus.GENERATING,
      locked_until: lockedUntil,
      attempt_count: attemptCount + 1,
    })
    .eq('id', requestId)
    .eq('status', ReportRequestStatus.QUEUED)
    .select('*');

  if (error) {
    throw error;
  }
  return (data?.[0] as ReportRequestRow) ?? null;
}

/**
 * Lease recovery: a row stranded `generating` past its lease (a deploy
 * killed the worker mid-render) is re-claimed by the same guarded UPDATE
 * with the lease predicate, attempt_count bumped by one.
 */
export async function recoverExpiredReport(
  admin: SupabaseClient,
  requestId: string,
  lockedUntil: string,
  attemptCount: number,
): Promise<ReportRequestRow | null> {
  const { data, error } = await admin
    .from('report_requests')
    .update({
      status: ReportRequestStatus.GENERATING,
      locked_until: lockedUntil,
      attempt_count: attemptCount + 1,
    })
    .eq('id', requestId)
    .eq('status', ReportRequestStatus.GENERATING)
    .lt('locked_until', new Date().toISOString())
    .select('*');

  if (error) {
    throw error;
  }
  return (data?.[0] as ReportRequestRow) ?? null;
}

/**
 * Terminal failure stamp. Guarded on `generating` so a stale worker can
 * never overwrite a row a recovered attempt already finished.
 */
export async function markReportFailed(
  admin: SupabaseClient,
  requestId: string,
  errorCode: string,
): Promise<void> {
  const { error } = await admin
    .from('report_requests')
    .update({
      status: ReportRequestStatus.FAILED,
      error_code: errorCode,
      completed_at: new Date().toISOString(),
    })
    .eq('id', requestId)
    .eq('status', ReportRequestStatus.GENERATING);

  if (error) {
    throw error;
  }
}

/**
 * Ready stamp — strictly after the R2 upload succeeded (FR-4 terminal
 * ordering): r2_key + file_size_bytes + completed_at land together with
 * status='ready'. There is never a partial or linkless "ready".
 */
export async function stampReportReady(
  admin: SupabaseClient,
  requestId: string,
  r2Key: string,
  fileSizeBytes: number,
): Promise<void> {
  const { error } = await admin
    .from('report_requests')
    .update({
      status: ReportRequestStatus.READY,
      r2_key: r2Key,
      file_size_bytes: fileSizeBytes,
      completed_at: new Date().toISOString(),
    })
    .eq('id', requestId)
    .eq('status', ReportRequestStatus.GENERATING);

  if (error) {
    throw error;
  }
}
