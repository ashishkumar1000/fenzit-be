import { Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { UpdateJobDto } from './dto/update-job.dto';
import type { JobPriority } from './enums/job-priority.enum';

/**
 * Event types for the pending-job approval notifications (epic
 * employee-created-jobs, stories 4-5). The rows are written by the database
 * RPCs (create_job_with_log, decide_pending_job, update_job_with_log) in the
 * same step as the change, so a row exists only when the change committed.
 * This file only names the types for the push copy and tests.
 */
export const PENDING_JOB_EVENT = {
  /** To each active owner, once per submission. */
  SUBMITTED: 'job.submitted',
  /** To the creator, once per approval. */
  APPROVED: 'job.approved',
  /** To the creator, once per rejection. */
  REJECTED: 'job.rejected',
  /** To the creator, once per owner cancel of a pending job. */
  CANCELLED: 'job.cancelled',
  /** To the creator, once per owner save that changed a pending job. */
  EDITED: 'job.edited',
} as const;

const logger = new Logger('PendingJobNotifications');

/** The job fields the pending-job alerts need. A full JobRow satisfies it. */
export interface PendingJobAlertRow {
  id: string;
  tenant_id: string;
  job_number: string;
  customer_id: string;
  created_by?: string | null;
}

interface NotificationInsert {
  tenant_id: string;
  user_id: string;
  job_id: string;
  event_type: string;
  payload: Record<string, unknown>;
}

async function customerNameOf(
  admin: SupabaseClient,
  job: PendingJobAlertRow,
): Promise<string | null> {
  const { data, error } = await admin
    .from('customers')
    .select('name')
    .eq('id', job.customer_id)
    .eq('tenant_id', job.tenant_id)
    .maybeSingle<{ name: string | null }>();
  if (error) {
    throw error;
  }
  return typeof data?.name === 'string' ? data.name : null;
}

async function userNameOf(
  admin: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from('users')
    .select('name')
    .eq('id', userId)
    .maybeSingle<{ name: string | null }>();
  if (error) {
    throw error;
  }
  return typeof data?.name === 'string' ? data.name : null;
}

async function insertAlerts(
  admin: SupabaseClient,
  rows: NotificationInsert[],
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  const { error } = await admin.from('notifications').insert(rows);
  if (error) {
    throw error;
  }
}

/**
 * Log-and-drop, like job.assigned: the job change already committed, so a
 * failed alert never fails the request.
 */
async function alertSafely(
  what: string,
  job: PendingJobAlertRow,
  work: () => Promise<void>,
): Promise<void> {
  try {
    await work();
  } catch (err: unknown) {
    logger.error(`Failed to insert ${what} alert (dropped):`, {
      tenantId: job.tenant_id,
      jobId: job.id,
      err,
    });
  }
}

/** Every active owner, except the employee who submitted the job. */
export async function alertOwnersOfSubmission(
  admin: SupabaseClient,
  job: PendingJobAlertRow,
  employeeId: string,
): Promise<void> {
  await alertSafely(PENDING_JOB_EVENT.SUBMITTED, job, async () => {
    const { data, error } = await admin
      .from('memberships')
      .select('user_id')
      .eq('tenant_id', job.tenant_id)
      .eq('role', 'company_admin')
      .eq('status', 'active')
      .neq('user_id', employeeId)
      .returns<{ user_id: string }[]>();
    if (error) {
      throw error;
    }
    const owners = data ?? [];
    if (owners.length === 0) {
      return;
    }
    const customerName = await customerNameOf(admin, job);
    const employeeName = await userNameOf(admin, employeeId);
    await insertAlerts(
      admin,
      owners.map((o) => ({
        tenant_id: job.tenant_id,
        user_id: o.user_id,
        job_id: job.id,
        event_type: PENDING_JOB_EVENT.SUBMITTED,
        payload: {
          job_number: job.job_number,
          customer_name: customerName,
          employee_name: employeeName,
        },
      })),
    );
  });
}

/** The creator hears about an approve or reject. Skipped when the owner is the creator. */
export async function alertCreatorOfDecision(
  admin: SupabaseClient,
  job: PendingJobAlertRow,
  actorId: string,
  decision: 'approve' | 'reject',
  reason: string | null,
): Promise<void> {
  const creatorId = job.created_by ?? null;
  if (creatorId === null || creatorId === actorId) {
    return;
  }
  const event =
    decision === 'approve'
      ? PENDING_JOB_EVENT.APPROVED
      : PENDING_JOB_EVENT.REJECTED;
  await alertSafely(event, job, async () => {
    const customerName = await customerNameOf(admin, job);
    await insertAlerts(admin, [
      {
        tenant_id: job.tenant_id,
        user_id: creatorId,
        job_id: job.id,
        event_type: event,
        payload: {
          job_number: job.job_number,
          customer_name: customerName,
          reason,
        },
      },
    ]);
  });
}

/** The creator hears about an owner cancel of a PENDING job. */
export async function alertCreatorOfCancel(
  admin: SupabaseClient,
  job: PendingJobAlertRow,
  actorId: string,
): Promise<void> {
  const creatorId = job.created_by ?? null;
  if (creatorId === null || creatorId === actorId) {
    return;
  }
  await alertSafely(PENDING_JOB_EVENT.CANCELLED, job, async () => {
    const customerName = await customerNameOf(admin, job);
    await insertAlerts(admin, [
      {
        tenant_id: job.tenant_id,
        user_id: creatorId,
        job_id: job.id,
        event_type: PENDING_JOB_EVENT.CANCELLED,
        payload: { job_number: job.job_number, customer_name: customerName },
      },
    ]);
  });
}

/** The creator hears about one owner save that changed a PENDING job. Field names only. */
export async function alertCreatorOfEdit(
  admin: SupabaseClient,
  job: PendingJobAlertRow,
  actorId: string,
  changedFields: string[],
): Promise<void> {
  const creatorId = job.created_by ?? null;
  if (
    creatorId === null ||
    creatorId === actorId ||
    changedFields.length === 0
  ) {
    return;
  }
  await alertSafely(PENDING_JOB_EVENT.EDITED, job, async () => {
    const customerName = await customerNameOf(admin, job);
    await insertAlerts(admin, [
      {
        tenant_id: job.tenant_id,
        user_id: creatorId,
        job_id: job.id,
        event_type: PENDING_JOB_EVENT.EDITED,
        payload: {
          job_number: job.job_number,
          customer_name: customerName,
          changed_fields: changedFields,
        },
      },
    ]);
  });
}

/** The job as it stood before an owner save: read once, before the RPC. */
export interface JobBeforeUpdate extends PendingJobAlertRow {
  status: string;
  technician_id: string;
  description: string | null;
  scheduled_start: string;
  scheduled_end: string | null;
  notes_for_technician: string | null;
  priority: JobPriority;
}

const sameInstant = (a: string | null, b: string): boolean =>
  a !== null && Date.parse(a) === Date.parse(b);

/**
 * The fields an owner save really changes, named as the activity log names
 * them. Only fields the request sent count; a value equal to the stored one
 * is not a change. Mirrors the database's own diff for the alert text.
 */
export function changedEditFields(
  before: JobBeforeUpdate,
  dto: UpdateJobDto,
): string[] {
  const changed: string[] = [];
  if (dto.description != null && dto.description !== before.description) {
    changed.push('description');
  }
  if (
    dto.scheduledStart !== undefined &&
    !sameInstant(before.scheduled_start, dto.scheduledStart)
  ) {
    changed.push('scheduledStart');
  }
  if (
    dto.scheduledEnd != null &&
    (before.scheduled_end === null ||
      !sameInstant(before.scheduled_end, dto.scheduledEnd))
  ) {
    changed.push('scheduledEnd');
  }
  if (
    dto.notesForTechnician != null &&
    dto.notesForTechnician !== before.notes_for_technician
  ) {
    changed.push('notesForTechnician');
  }
  if (dto.priority !== undefined && dto.priority !== before.priority) {
    changed.push('priority');
  }
  if (
    dto.technicianId !== undefined &&
    dto.technicianId !== before.technician_id
  ) {
    changed.push('technicianId');
  }
  return changed;
}
