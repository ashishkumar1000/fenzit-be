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
  countOutcomes,
  creatorKind,
  employeesWithPermissionNoJobs,
  minutesToDecision,
  outcomeOf,
  ownerHeadline,
  ownerPipeline,
  perEmployee,
  ratio,
  average,
  median,
  type EmployeeRow,
  type OutcomeCounts,
  type OwnerHeadline,
  type OwnerPipeline,
} from './job-report-rules';
import {
  loadMembers,
  loadWindowJobs,
  requireCompany,
  resolveReportWindow,
  type ReportWindow,
} from './job-report-data';

export interface OwnerReportResponse {
  range: { from: string; to: string };
  headline: OwnerHeadline;
  pipeline: OwnerPipeline;
  perEmployee: EmployeeRow[];
  employeesWithPermissionNoJobs: Array<{
    employeeId: string;
    name: string | null;
  }>;
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
  ): Promise<OwnerReportResponse> {
    const tenantId = requireCompany(user);
    const window = resolveReportWindow(query);
    const admin = this.supabaseClientFactory.createAdmin();
    const members = await loadMembers(admin, tenantId);
    const jobs = await loadWindowJobs(admin, tenantId, window);

    const employeeJobs = jobs.filter(
      (j) => creatorKind(j.createdBy, members) === 'employee',
    );
    const creatorIds = new Set(employeeJobs.map((j) => j.createdBy as string));

    return {
      range: { from: window.from, to: window.to },
      headline: ownerHeadline(jobs, members),
      pipeline: ownerPipeline(employeeJobs, Date.now()),
      perEmployee: perEmployee(employeeJobs, members),
      employeesWithPermissionNoJobs: employeesWithPermissionNoJobs(
        members,
        creatorIds,
      ),
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
