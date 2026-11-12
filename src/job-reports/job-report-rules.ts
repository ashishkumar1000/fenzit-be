/**
 * Story 6 (CAP-8, CAP-9 data): the rules that turn job records into report
 * numbers. Pure functions, no database. The service feeds them rows; the same
 * definitions serve the owner and the employee dashboards, so web and mobile
 * agree.
 *
 * Plain English:
 *  - A job's creator is an owner (or no creator, for old rows) or an employee.
 *  - An employee's job is one of four outcomes: pending, rejected, approved by
 *    the owner, or auto-approved (approval was off, so it was assigned at once).
 *  - Approval rate = approved / (approved + rejected). Time to decision runs from
 *    the job's creation (its submission) to the owner's decision.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

export type ApprovalOutcome =
  'pending' | 'rejected' | 'approved' | 'auto_approved';

export interface ReportJob {
  id: string;
  jobNumber: string;
  createdBy: string | null;
  status: string;
  createdAt: string;
  decidedAt: string | null;
  rejectionReason: string | null;
}

/** Membership facts the rules need: who is an owner and who is an employee. */
export interface MemberFact {
  role: 'company_admin' | 'employee' | 'viewer';
  name: string | null;
  canCreateJobs: boolean;
  status: 'invited' | 'active' | 'removed';
}

export type CreatorKind = 'owner' | 'employee';

/**
 * A job with no creator (old rows) is an owner job. So is a creator who has no
 * membership row (a platform admin creating a job). A known employee is an
 * employee, even if they have since been removed or disabled.
 */
export function creatorKind(
  createdBy: string | null,
  members: ReadonlyMap<string, MemberFact>,
): CreatorKind {
  if (createdBy === null) return 'owner';
  const fact = members.get(createdBy);
  if (!fact || fact.role === 'company_admin') return 'owner';
  return 'employee';
}

export function outcomeOf(job: ReportJob): ApprovalOutcome {
  if (job.status === 'pending_approval') return 'pending';
  if (job.status === 'rejected') return 'rejected';
  if (job.decidedAt !== null) return 'approved';
  return 'auto_approved';
}

/** Minutes from submission (job creation) to the owner's decision. */
export function minutesToDecision(job: ReportJob): number | null {
  if (job.decidedAt === null) return null;
  return (Date.parse(job.decidedAt) - Date.parse(job.createdAt)) / 60000;
}

export function ratio(part: number, whole: number): number | null {
  if (whole === 0) return null;
  return Math.round((part / whole) * 10000) / 10000;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const m =
    sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(m * 100) / 100;
}

export function average(values: number[]): number | null {
  if (values.length === 0) return null;
  const sum = values.reduce((a, b) => a + b, 0);
  return Math.round((sum / values.length) * 100) / 100;
}

export interface OutcomeCounts {
  created: number;
  approved: number;
  autoApproved: number;
  rejected: number;
  pending: number;
}

export function countOutcomes(jobs: ReportJob[]): OutcomeCounts {
  const c: OutcomeCounts = {
    created: jobs.length,
    approved: 0,
    autoApproved: 0,
    rejected: 0,
    pending: 0,
  };
  for (const job of jobs) {
    switch (outcomeOf(job)) {
      case 'approved':
        c.approved += 1;
        break;
      case 'auto_approved':
        c.autoApproved += 1;
        break;
      case 'rejected':
        c.rejected += 1;
        break;
      case 'pending':
        c.pending += 1;
        break;
    }
  }
  return c;
}

export interface OwnerHeadline {
  employeeCreated: number;
  employeeApproved: number;
  employeeAutoApproved: number;
  ownerCreated: number;
}

/** The four required headline counts (reports-dashboard.md, owner row one). */
export function ownerHeadline(
  jobs: ReportJob[],
  members: ReadonlyMap<string, MemberFact>,
): OwnerHeadline {
  const employeeJobs = jobs.filter(
    (j) => creatorKind(j.createdBy, members) === 'employee',
  );
  const counts = countOutcomes(employeeJobs);
  return {
    employeeCreated: counts.created,
    employeeApproved: counts.approved,
    employeeAutoApproved: counts.autoApproved,
    ownerCreated: jobs.length - employeeJobs.length,
  };
}

export interface OwnerPipeline {
  pending: number;
  pendingOverOneDay: number;
  rejected: number;
  rejectedWithReason: number;
  rejectedWithoutReason: number;
  approvalRate: number | null;
  averageMinutesToDecision: number | null;
  medianMinutesToDecision: number | null;
  oldestPending: { id: string; jobNumber: string; submittedAt: string } | null;
}

export function ownerPipeline(
  employeeJobs: ReportJob[],
  nowMs: number,
): OwnerPipeline {
  const counts = countOutcomes(employeeJobs);
  const pendingJobs = employeeJobs.filter((j) => outcomeOf(j) === 'pending');
  const rejectedJobs = employeeJobs.filter((j) => outcomeOf(j) === 'rejected');
  const minutes = employeeJobs
    .map(minutesToDecision)
    .filter((m): m is number => m !== null);
  const oldest = [...pendingJobs].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
  )[0];
  return {
    pending: counts.pending,
    pendingOverOneDay: pendingJobs.filter(
      (j) => nowMs - Date.parse(j.createdAt) > DAY_MS,
    ).length,
    rejected: counts.rejected,
    rejectedWithReason: rejectedJobs.filter((j) => j.rejectionReason).length,
    rejectedWithoutReason: rejectedJobs.filter((j) => !j.rejectionReason)
      .length,
    approvalRate: ratio(counts.approved, counts.approved + counts.rejected),
    averageMinutesToDecision: average(minutes),
    medianMinutesToDecision: median(minutes),
    oldestPending: oldest
      ? {
          id: oldest.id,
          jobNumber: oldest.jobNumber,
          submittedAt: oldest.createdAt,
        }
      : null,
  };
}

export interface EmployeeRow extends OutcomeCounts {
  employeeId: string;
  name: string | null;
  shareOfEmployeeCreated: number | null;
}

/** Per-employee table for the owner (one row per creator with jobs in range). */
export function perEmployee(
  employeeJobs: ReportJob[],
  members: ReadonlyMap<string, MemberFact>,
): EmployeeRow[] {
  const byCreator = new Map<string, ReportJob[]>();
  for (const job of employeeJobs) {
    const id = job.createdBy as string;
    byCreator.set(id, [...(byCreator.get(id) ?? []), job]);
  }
  const total = employeeJobs.length;
  return [...byCreator.entries()]
    .map(([employeeId, jobs]) => ({
      employeeId,
      name: members.get(employeeId)?.name ?? null,
      shareOfEmployeeCreated: ratio(jobs.length, total),
      ...countOutcomes(jobs),
    }))
    .sort(
      (a, b) =>
        b.created - a.created || (a.name ?? '').localeCompare(b.name ?? ''),
    );
}

/** Active employees with job creation switched on who created nothing in range. */
export function employeesWithPermissionNoJobs(
  members: ReadonlyMap<string, MemberFact>,
  creatorIds: ReadonlySet<string>,
): Array<{ employeeId: string; name: string | null }> {
  return [...members.entries()]
    .filter(
      ([id, f]) =>
        f.role === 'employee' &&
        f.status === 'active' &&
        f.canCreateJobs &&
        !creatorIds.has(id),
    )
    .map(([employeeId, f]) => ({ employeeId, name: f.name }))
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
}
