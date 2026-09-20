import type { TechnicianJobActivityData } from './technician-job-activity.data';

/**
 * "Needs attention" flags for the Technician Job Activity report — surfaces
 * what an owner should look into (user request, 2026-09-20). A pure function
 * over the fetched data so it is testable with no DB.
 *
 * Flag wording is deliberately plain English (user request, 2026-09-20:
 * the report must read easily for someone with average English).
 *
 * Rules:
 * - Overdue ("Not done on time"): a job still open (scheduled / in_progress)
 *   whose scheduled start has passed (range ends today at the latest, so
 *   this is "was due, still not done").
 * - Urgent open ("Urgent job not done"): an urgent-priority job still open
 *   (folded into the Overdue detail when both apply).
 * - Completed without proof ("No proof of work"): a completed job with zero
 *   photo/signature attachments — no service evidence captured.
 * - Cancelled: informational — worth a follow-up by the owner.
 */

export type FlagKind =
  'Not done on time' | 'Urgent job not done' | 'No proof of work' | 'Cancelled';

export interface FlaggedJob {
  jobNumber: string;
  technicianName: string;
  kind: FlagKind;
  detail: string;
}

const OPEN_STATUSES = new Set(['scheduled', 'in_progress']);

export function computeFlags(
  data: TechnicianJobActivityData,
  nowIso: string,
): FlaggedJob[] {
  const technicianNames = new Map(data.technicians.map((t) => [t.id, t.name]));
  const flags: FlaggedJob[] = [];

  for (const job of data.jobs) {
    const technicianName =
      technicianNames.get(job.technicianId) ?? 'Unknown technician';
    const isOpen = OPEN_STATUSES.has(job.status);

    if (isOpen && job.scheduledStart < nowIso) {
      flags.push({
        jobNumber: job.jobNumber,
        technicianName,
        kind:
          job.priority === 'urgent'
            ? 'Urgent job not done'
            : 'Not done on time',
        detail:
          job.priority === 'urgent'
            ? 'This is an urgent job. Its planned time has passed and it is not done yet.'
            : job.status === 'in_progress'
              ? 'Work has started, but the planned time has passed.'
              : 'The planned time has passed, but the job has not started.',
      });
      continue;
    }

    if (
      job.status === 'completed' &&
      job.photoCount + job.signatureCount === 0
    ) {
      flags.push({
        jobNumber: job.jobNumber,
        technicianName,
        kind: 'No proof of work',
        detail:
          'The job shows as done, but no photo or signature was saved as proof.',
      });
      continue;
    }

    if (job.status === 'cancelled') {
      flags.push({
        jobNumber: job.jobNumber,
        technicianName,
        kind: 'Cancelled',
        detail:
          'This job was cancelled. Please check if the customer needs help.',
      });
    }
  }

  const severity: Record<FlagKind, number> = {
    'Urgent job not done': 0,
    'Not done on time': 1,
    'No proof of work': 2,
    Cancelled: 3,
  };
  return flags.sort((a, b) => severity[a.kind] - severity[b.kind]);
}
