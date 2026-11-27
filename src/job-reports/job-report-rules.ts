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
  'pending' | 'rejected' | 'approved' | 'auto_approved' | 'cancelled';

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
  // 'deactivated' is a real membership status since the profile round
  // (2026-11-21); the only status branch (`=== 'active'`) already drops
  // deactivated members from job permission — same treatment as removed.
  status: 'invited' | 'active' | 'deactivated' | 'removed';
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

/**
 * A cancelled job has its own bucket. The database stamps decided_at on a
 * cancelled pending job, and that stamp cannot be told apart from an approved
 * job that was later cancelled, so neither counts as approved or auto-approved.
 */
export function outcomeOf(job: ReportJob): ApprovalOutcome {
  if (job.status === 'pending_approval') return 'pending';
  if (job.status === 'rejected') return 'rejected';
  if (job.status === 'cancelled') return 'cancelled';
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
  cancelled: number;
}

export function countOutcomes(jobs: ReportJob[]): OutcomeCounts {
  const c: OutcomeCounts = {
    created: jobs.length,
    approved: 0,
    autoApproved: 0,
    rejected: 0,
    pending: 0,
    cancelled: 0,
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
      case 'cancelled':
        c.cancelled += 1;
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

/** ── The exec-dashboard trend sections (2026-11-27 overview revamp) ────── */

/** The overview's charts slice the window into this many equal buckets. */
export const TREND_BUCKET_COUNT = 5;

export interface WindowSlice {
  from: string;
  to: string;
}

/** Inclusive day count between two YYYY-MM-DD dates (from may equal to). */
export function spanDaysInclusive(from: string, to: string): number {
  return (
    Math.floor(
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
        DAY_MS,
    ) + 1
  );
}

function shiftDay(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/**
 * The window cut into `count` equal day slices (the last one always ends at
 * `to`). The overview's three charts share one slicing so their x-axes line
 * up; five buckets over 30 days is the mock's weekly rhythm.
 */
export function sliceWindow(from: string, to: string, count: number): WindowSlice[] {
  const span = spanDaysInclusive(from, to);
  const sliceLen = Math.ceil(span / count);
  const slices: WindowSlice[] = [];
  let cursor = from;
  for (let i = 0; i < count; i += 1) {
    const end = shiftDay(cursor, sliceLen - 1);
    const capped = end < to ? end : to;
    slices.push({ from: cursor, to: capped });
    if (capped === to) break;
    cursor = shiftDay(capped, 1);
  }
  return slices;
}

export interface CumulativeJobFlow {
  employeeCreated: number;
  employeeApproved: number;
  employeeAutoApproved: number;
  ownerCreated: number;
}

/**
 * The headline counts accumulated as-of each cut instant (exclusive upper
 * bounds, oldest first). The SAME definitions as ownerHeadline — the exec
 * dashboard's rising lines are the headline accumulating over the window,
 * never a second counting rule. Cumulative means cumulative: a job before
 * an early cut is also before every later one, so it counts in every later
 * bucket too (the same as-of semantics `workforceAtCuts` documents).
 */
export function cumulativeJobFlow(
  jobs: ReportJob[],
  members: ReadonlyMap<string, MemberFact>,
  cutsExclusive: Date[],
): CumulativeJobFlow[] {
  const counts = cutsExclusive.map(() => ({
    employeeCreated: 0,
    employeeApproved: 0,
    employeeAutoApproved: 0,
    ownerCreated: 0,
  }));
  for (const job of jobs) {
    const at = Date.parse(job.createdAt);
    const isEmployee = creatorKind(job.createdBy, members) === 'employee';
    const outcome = isEmployee ? outcomeOf(job) : null;
    // The cuts ascend, so the first cut past the job's creation is where its
    // counts start — every later cut includes it too. A job created after
    // the last cut belongs to no bucket.
    const first = cutsExclusive.findIndex((cut) => at < cut.getTime());
    // "Approved" is an as-of fact too: an approval that happened after a
    // cut must not count in that cut's bucket (the same ruling
    // workforceAtCuts applies to needsApproval). Auto-approval is
    // instantaneous at creation, so it rides the creation date.
    const approvedAt =
      outcome === 'approved' && job.decidedAt !== null
        ? Date.parse(job.decidedAt)
        : null;
    const approvedFirst =
      approvedAt === null
        ? counts.length
        : cutsExclusive.findIndex((cut) => approvedAt < cut.getTime());
    for (let i = first < 0 ? counts.length : first; i < counts.length; i += 1) {
      const bucket = counts[i];
      if (isEmployee) {
        bucket.employeeCreated += 1;
        if (i >= approvedFirst) bucket.employeeApproved += 1;
        else if (outcome === 'auto_approved') bucket.employeeAutoApproved += 1;
      } else {
        bucket.ownerCreated += 1;
      }
    }
  }
  return counts;
}

export interface WorkforceMembershipRow {
  /** ISO instant the membership was created (the invite). */
  createdAt: string;
  /** ISO instant of the row's last change — the removal stand-in. */
  updatedAt: string;
  status: 'invited' | 'active' | 'deactivated' | 'removed';
}

export interface WorkforceCounts {
  totalEmployees: number;
  activeEmployees: number;
  pendingInvites: number;
  needsApproval: number;
}

/**
 * Workforce counts AS OF each cut instant (exclusive upper bounds, oldest
 * first). Honest semantics, documented on the wire:
 *  - `totalEmployees` grows from created_at and shrinks when a member is
 *    `removed` before the cut (updated_at stands in for a removal stamp —
 *    the table has no dedicated one).
 *  - `activeEmployees` / `pendingInvites` back-project the CURRENT status:
 *    the invited→active transition is not dated anywhere, so a member who is
 *    active today counts as active across the whole window. The near-flat
 *    lines the design shows are the true shape of that data.
 *  - `needsApproval` is exact history: a job is pending at a cut when it was
 *    created before it and not decided by it (a cancellation stamps
 *    decided_at, so a cancelled job only counts while it was still waiting).
 */
export function workforceAtCuts(
  memberships: WorkforceMembershipRow[],
  jobs: ReportJob[],
  cutsExclusive: Date[],
): WorkforceCounts[] {
  return cutsExclusive.map((cut) => {
    const at = cut.getTime();
    let totalEmployees = 0;
    let activeEmployees = 0;
    let pendingInvites = 0;
    for (const m of memberships) {
      if (Date.parse(m.createdAt) >= at) continue;
      if (m.status === 'removed' && Date.parse(m.updatedAt) < at) continue;
      totalEmployees += 1;
      if (m.status === 'active') activeEmployees += 1;
      else if (m.status === 'invited') pendingInvites += 1;
    }
    let needsApproval = 0;
    for (const j of jobs) {
      // A job that never waited for approval must never count: an
      // auto-approved job (and an owner-created one, which is approved at
      // creation) carries decided_at null for its whole life, and the pool
      // is unfiltered by creator — only the current outcome says whether
      // this row ever stood in the queue (review 2026-11-28).
      if (outcomeOf(j) !== 'pending' && j.decidedAt === null) continue;
      if (Date.parse(j.createdAt) >= at) continue;
      if (j.decidedAt !== null && Date.parse(j.decidedAt) < at) continue;
      needsApproval += 1;
    }
    return { totalEmployees, activeEmployees, pendingInvites, needsApproval };
  });
}
