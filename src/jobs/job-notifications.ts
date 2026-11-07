import { Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Job-assignment notification (user decision 2026-11-07, plan amendment):
 * creating a job with a technician, or moving a job to a DIFFERENT
 * technician, writes one `job.assigned` row for that technician only —
 * never for the acting admin (they asked for it), never for the previous
 * technician (they are losing the job), never when the technician didn't
 * actually change (a no-op PATCH must not ring the bell).
 *
 * Shaped on reports/engine/report-notifications.ts: inserted by the TS
 * write path AFTER the job write committed (this insert is not inside the
 * RPC, so every future writer shares one helper); a failure here is
 * logged and dropped — the job save is the contract, the bell and the
 * push are additive. job_id is set (the FE job-card pipeline groups on
 * it); NO dedupe_key (each assignment event is its own row — reassigning
 * back and forth SHOULD notify each time). The notifications table's
 * AFTER INSERT trigger fans the row out over Realtime untouched; the push
 * sweep picks it up off pushed_at.
 */

const logger = new Logger('JobNotifications');

export const JOB_ASSIGNED_EVENT = 'job.assigned';

/** The bare job fields the helper needs (a full JobRow satisfies it). */
export interface JobAssignmentRow {
  id: string;
  tenant_id: string;
  job_number: string;
  customer_id: string;
  scheduled_start: string;
}

export async function insertJobAssignedNotification(
  admin: SupabaseClient,
  job: JobAssignmentRow,
  recipientId: string,
  // The customer name when the calling flow already has it (the
  // new-customer create path returns the full row) — skips the read below.
  knownCustomerName?: string | null,
): Promise<void> {
  try {
    // The customer name rides the payload when known ("when known" per the
    // plan): the caller's hand-me-down name when given, else one cheap
    // tenant-scoped read; a miss simply omits the field (the FE and the
    // push copy both degrade per-field).
    let customerName: string | null =
      typeof knownCustomerName === 'string' &&
      knownCustomerName.trim().length > 0
        ? knownCustomerName
        : null;
    if (customerName === null) {
      const { data: customer, error: customerError } = await admin
        .from('customers')
        .select('name')
        .eq('id', job.customer_id)
        .eq('tenant_id', job.tenant_id)
        .maybeSingle<{ name: string | null }>();
      if (customerError) {
        throw customerError;
      }
      customerName = typeof customer?.name === 'string' ? customer.name : null;
    }
    const payload: Record<string, unknown> = {
      job_number: job.job_number,
      scheduled_start: job.scheduled_start,
    };
    if (customerName !== null && customerName.trim().length > 0) {
      payload['customer_name'] = customerName;
    }

    const { error } = await admin.from('notifications').insert({
      tenant_id: job.tenant_id,
      user_id: recipientId,
      job_id: job.id,
      event_type: JOB_ASSIGNED_EVENT,
      payload,
    });
    if (error) {
      throw error;
    }
  } catch (err: unknown) {
    // Logged and dropped by design — the job write already succeeded.
    logger.error('Failed to insert job.assigned notification (dropped):', {
      tenantId: job.tenant_id,
      jobId: job.id,
      recipientId,
      err,
    });
  }
}
