import { Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ReportRequestStatus } from '../enums/report-status.enum';
import { ReportRequestRow } from '../report-response.model';

/**
 * Terminal notification (FR-8) — inserted by the worker right after the
 * terminal status stamp committed (app-level two-step: the stamp is the
 * commit point; a notification failure here is logged and dropped, and the
 * FE history polling is the designed fallback).
 *
 * Recipient is `requested_by` only — never all owners. The payload carries
 * the report id/status/label and deliberately NO URLs (the FE fetches a
 * fresh presigned URL from the status endpoint when the user taps the item).
 * job_id is NULL — report notifications point at a report, not a job
 * (migration 20260920000008 relaxed the column). The notifications table's
 * AFTER INSERT trigger fans the row out over Realtime untouched.
 */

const logger = new Logger('ReportNotifications');

export const REPORT_READY_EVENT = 'report_ready';
export const REPORT_FAILED_EVENT = 'report_failed';

export async function insertReportNotification(
  admin: SupabaseClient,
  row: ReportRequestRow,
  definitionLabel: string,
): Promise<void> {
  const failed = row.status === ReportRequestStatus.FAILED;
  try {
    const { error } = await admin.from('notifications').insert({
      tenant_id: row.tenant_id,
      user_id: row.requested_by,
      job_id: null,
      event_type: failed ? REPORT_FAILED_EVENT : REPORT_READY_EVENT,
      payload: {
        reportId: row.id,
        reportType: row.report_type,
        reportLabel: definitionLabel,
        status: row.status,
        errorCode: row.error_code ?? null,
      },
    });
    if (error) {
      throw error;
    }
  } catch (err) {
    // Logged and dropped by design — the history list still shows the truth.
    logger.error('Failed to insert report notification (dropped):', {
      tenantId: row.tenant_id,
      requestId: row.id,
      err,
    });
  }
}
