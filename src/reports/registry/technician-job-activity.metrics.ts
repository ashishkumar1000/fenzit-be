import type { FetchedJob } from './technician-job-activity.data';

/**
 * Metric definitions for the Technician Job Activity report (PRD §4 / FR17)
 * — a pure function over the fetched jobs, so it is testable with no DB.
 */

export interface ActivityMetrics {
  /** All jobs in range, every status. */
  totalAssigned: number;
  completed: number;
  cancelled: number;
  /** scheduled + in_progress. */
  open: number;
  /** priority = 'urgent' among completed jobs. */
  urgentCompleted: number;
  /**
   * On-time completed ÷ completed jobs — completed-only denominator; jobs
   * with null scheduled_end are excluded from the denominator; zero
   * completed renders "—" (never 0% or NaN). Formatted with the % suffix.
   */
  onTimePercent: string;
  /** Distinct customers served — all statuses. */
  distinctCustomers: number;
  /** photo + signature attachments on those jobs. */
  photosAndSignatures: number;
}

export function computeMetrics(jobs: FetchedJob[]): ActivityMetrics {
  const completedJobs = jobs.filter((j) => j.status === 'completed');
  const onTimeDenominator = completedJobs.filter(
    (j) => j.scheduledEnd !== null,
  );
  const onTimeNumerator = onTimeDenominator.filter(
    (j) => j.completedAt !== null && j.completedAt <= j.scheduledEnd!,
  );

  return {
    totalAssigned: jobs.length,
    completed: completedJobs.length,
    cancelled: jobs.filter((j) => j.status === 'cancelled').length,
    open: jobs.filter(
      (j) => j.status === 'scheduled' || j.status === 'in_progress',
    ).length,
    urgentCompleted: completedJobs.filter((j) => j.priority === 'urgent')
      .length,
    onTimePercent:
      onTimeDenominator.length === 0
        ? '—'
        : `${Math.round((onTimeNumerator.length / onTimeDenominator.length) * 100)}%`,
    distinctCustomers: new Set(jobs.map((j) => j.customerId)).size,
    photosAndSignatures: jobs.reduce(
      (sum, j) => sum + j.photoCount + j.signatureCount,
      0,
    ),
  };
}
