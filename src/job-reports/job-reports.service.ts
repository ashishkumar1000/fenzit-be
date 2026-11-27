import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ErrorCode } from '../common/enums/error-code.enum';
import { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { JobReportRangeDto } from './dto/job-report-range.dto';
import {
  cumulativeJobFlow,
  countOutcomes,
  creatorKind,
  minutesToDecision,
  outcomeOf,
  ownerHeadline,
  ratio,
  average,
  median,
  sliceWindow,
  TREND_BUCKET_COUNT,
  workforceAtCuts,
  type OutcomeCounts,
  type OwnerHeadline,
  type WindowSlice,
} from './job-report-rules';
import {
  loadMembers,
  loadPendingHistoryPool,
  loadWindowJobs,
  loadWorkforceMemberships,
  requireCompany,
  resolveReportWindow,
  type ReportWindow,
} from './job-report-data';
import { getIstDayRange } from '../common/utils/ist-day-range.util';

export interface OwnerTrendBucket extends WindowSlice {
  employeeCreated: number;
  employeeApproved: number;
  employeeAutoApproved: number;
  ownerCreated: number;
}

export interface OwnerTrend {
  /** Equal slices of the window, oldest first; counts cumulative AT each
   *  slice's end — the exec dashboard's rising lines. */
  buckets: OwnerTrendBucket[];
  /** approved / (approved + rejected) over the window — the pipeline's
   *  approval rate re-surfaced as the banner's turnaround efficiency. */
  turnaroundEfficiency: number | null;
}

export interface OwnerWorkforceBucket extends WindowSlice {
  totalEmployees: number;
  activeEmployees: number;
  pendingInvites: number;
  needsApproval: number;
}

export interface OwnerWorkforce {
  /** Equal slices of the window, oldest first; counts AS OF each slice's
   *  end (see workforceAtCuts for the honest semantics). */
  buckets: OwnerWorkforceBucket[];
}

/**
 * The light owner report (2026-11-28 slimming): the mobile app's summary and
 * the jobs page's waiting badge read only these, so the default response
 * carries just them — the expensive chart sections ride the same endpoint
 * only when `?charts=true` asks for them.
 */
export interface OwnerReportResponse {
  range: { from: string; to: string };
  headline: OwnerHeadline;
  /**
   * The pipeline object the mobile app reads (`pipeline.pending`, Epic 22) —
   * only the waiting count survives the overview revamp; the rest of the old
   * pipeline (aged pending, rejection splits, wait minutes, oldest job)
   * retired with the overview cards it fed.
   */
  pipeline: { pending: number };
}

/** The exec dashboard's report: the light report plus the two chart
 *  sections — `GET /job-reports/owner?charts=true`, the overview page's ask. */
export interface OwnerExecReportResponse extends OwnerReportResponse {
  /** 2026-11-27 exec dashboard: the cumulative job-flow chart + efficiency. */
  trend: OwnerTrend;
  /** 2026-11-27 exec dashboard: the workforce analytics chart. */
  workforce: OwnerWorkforce;
}

export interface EmployeeReportResponse {
  range: { from: string; to: string };
  created: OutcomeCounts;
  approvalRate: number | null;
  averageMinutesToDecision: number | null;
  medianMinutesToDecision: number | null;
  /** Jobs assigned to me that are scheduled or in progress right now. */
  assignedNow: number;
  /** Jobs assigned to me that were completed inside the window. */
  completedInRange: number;
  /** My rejected jobs in the window, most recent decision first. */
  rejectionReasons: Array<{
    jobId: string;
    jobNumber: string;
    reason: string | null;
    decidedAt: string;
  }>;
  /**
   * How many rejections there really were in the window. The list above is
   * capped for transport; this count is not, so a client can always say
   * "+ N more" truthfully.
   */
  rejectionReasonsTotal: number;
}

const REJECTION_LIST_LIMIT = 50;

/**
 * Story 6 (CAP-8, CAP-9 data): the owner and employee report numbers. Every
 * figure is computed here from job rows in the window, never from a stored
 * counter. The clients only display what comes back.
 */
@Injectable()
export class JobReportsService {
  private readonly logger = new Logger(JobReportsService.name);

  constructor(private readonly supabaseClientFactory: SupabaseClientFactory) {}

  async ownerReport(
    user: RequestUser,
    query: JobReportRangeDto,
  ): Promise<OwnerReportResponse | OwnerExecReportResponse> {
    const tenantId = requireCompany(user);
    const window = resolveReportWindow(query);
    const admin = this.supabaseClientFactory.createAdmin();
    const members = await loadMembers(admin, tenantId);
    const jobs = await loadWindowJobs(admin, tenantId, window);

    const employeeJobs = jobs.filter(
      (j) => creatorKind(j.createdBy, members) === 'employee',
    );
    const counts = countOutcomes(employeeJobs);
    // The turnaround rate the trend banner shows — the same approved /
    // (approved + rejected) ratio the old pipeline carried, straight off the
    // outcome counts.
    const turnaroundEfficiency = ratio(
      counts.approved,
      counts.approved + counts.rejected,
    );
    const report: OwnerReportResponse = {
      range: { from: window.from, to: window.to },
      headline: ownerHeadline(jobs, members),
      pipeline: { pending: counts.pending },
    };
    // The chart sections' reads (workforce memberships + the pending history
    // pool) only run when the overview page asks for them — the mobile
    // summary and the jobs page's waiting badge must not pay for charts
    // they never read (2026-11-28 slimming).
    if (query.charts !== 'true') return report;

    // The exec dashboard's slices: five equal cuts of the window, each
    // bounded by the end of its last IST day (exclusive). One slicing serves
    // both the job-flow and the workforce chart so the x-axes line up.
    const slices = sliceWindow(window.from, window.to, TREND_BUCKET_COUNT);
    const cuts = slices.map((s) =>
      getIstDayRange(new Date(`${s.to}T06:30:00.000Z`)).end,
    );
    const [memberships, pendingPool] = await Promise.all([
      loadWorkforceMemberships(admin, tenantId),
      loadPendingHistoryPool(admin, tenantId, window),
    ]);
    const flow = cumulativeJobFlow(jobs, members, cuts);
    const workforce = workforceAtCuts(memberships, pendingPool, cuts);

    return {
      ...report,
      trend: {
        buckets: slices.map((slice, i) => ({ ...slice, ...flow[i] })),
        turnaroundEfficiency,
      },
      workforce: {
        buckets: slices.map((slice, i) => ({ ...slice, ...workforce[i] })),
      },
    };
  }

  async employeeReport(
    user: RequestUser,
    query: JobReportRangeDto,
  ): Promise<EmployeeReportResponse> {
    const tenantId = requireCompany(user);
    const window = resolveReportWindow(query);
    const admin = this.supabaseClientFactory.createAdmin();
    const mine = await loadWindowJobs(admin, tenantId, window, user.userId);

    const counts = countOutcomes(mine);
    // Cancelled jobs carry a decided_at stamp, but a cancellation is not a
    // decision — the wait figures cover the same population as approvalRate.
    const decided = mine
      .filter((j) => outcomeOf(j) !== 'cancelled')
      .map(minutesToDecision)
      .filter((m): m is number => m !== null);
    // The full list is counted BEFORE the transport cap, so the total is
    // always the true number of rejections in the window.
    const rejectedAll = mine
      .filter((j) => outcomeOf(j) === 'rejected')
      .sort((a, b) => (b.decidedAt ?? '').localeCompare(a.decidedAt ?? ''));
    const rejected = rejectedAll.slice(0, REJECTION_LIST_LIMIT);

    const [assignedNow, completedInRange] = await Promise.all([
      this.countAssigned(admin, tenantId, user.userId),
      this.countCompleted(admin, tenantId, user.userId, window),
    ]);

    return {
      range: { from: window.from, to: window.to },
      created: counts,
      approvalRate: ratio(counts.approved, counts.approved + counts.rejected),
      averageMinutesToDecision: average(decided),
      medianMinutesToDecision: median(decided),
      assignedNow,
      completedInRange,
      rejectionReasons: rejected.map((j) => ({
        jobId: j.id,
        jobNumber: j.jobNumber,
        reason: j.rejectionReason,
        decidedAt: j.decidedAt as string,
      })),
      rejectionReasonsTotal: rejectedAll.length,
    };
  }

  private async countAssigned(
    admin: SupabaseClient,
    tenantId: string,
    userId: string,
  ): Promise<number> {
    const { count, error } = await admin
      .from('jobs')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('technician_id', userId)
      .in('status', ['scheduled', 'in_progress']);
    return this.countOrFail(count, error, 'assigned');
  }

  private async countCompleted(
    admin: SupabaseClient,
    tenantId: string,
    userId: string,
    window: ReportWindow,
  ): Promise<number> {
    const { count, error } = await admin
      .from('jobs')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('technician_id', userId)
      .eq('status', 'completed')
      .gte('completed_at', window.start.toISOString())
      .lt('completed_at', window.end.toISOString());
    return this.countOrFail(count, error, 'completed');
  }

  private countOrFail(
    count: number | null,
    error: unknown,
    what: string,
  ): number {
    if (error) {
      this.logger.error(`Failed to count ${what} jobs for report`, { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to load reports',
      });
    }
    return count ?? 0;
  }
}
