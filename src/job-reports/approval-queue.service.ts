import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ErrorCode } from '../common/enums/error-code.enum';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { PaginatedResponse } from '../common/dto/paginated-response.dto';
import { decodeCursor, encodeCursor } from '../common/utils/cursor.util';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { ApprovalQueueQueryDto } from './dto/approval-queue-query.dto';
import { requireCompany } from './job-report-data';

export interface ApprovalQueueItem {
  id: string;
  jobNumber: string;
  submittedAt: string;
  /** Whole hours since the job was submitted. */
  ageHours: number;
  employee: { id: string; name: string | null } | null;
  customerName: string | null;
}

interface QueueRow {
  id: string;
  job_number: string;
  created_by: string | null;
  created_at: string;
  customers: { name: string | null } | { name: string | null }[] | null;
  creator: { name: string | null } | { name: string | null }[] | null;
}

const PAGE_SIZE = 50;
const HOUR_MS = 60 * 60 * 1000;

function first<T>(v: T | T[] | null): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

/**
 * Story 6 (CAP-10): the owner's approval queue. Only jobs waiting for approval
 * (pending_approval) in this company. Oldest submission first, so the job that
 * has waited longest is at the top.
 */
@Injectable()
export class ApprovalQueueService {
  private readonly logger = new Logger(ApprovalQueueService.name);

  constructor(private readonly supabaseClientFactory: SupabaseClientFactory) {}

  async list(
    user: RequestUser,
    query: ApprovalQueueQueryDto,
    now: Date = new Date(),
  ): Promise<PaginatedResponse<ApprovalQueueItem>> {
    const tenantId = requireCompany(user);
    const admin = this.supabaseClientFactory.createAdmin();

    let qb = admin
      .from('jobs')
      .select(
        'id, job_number, created_by, created_at, customers(name), creator:users!jobs_created_by_fkey(name)',
      )
      .eq('tenant_id', tenantId)
      .eq('status', 'pending_approval');

    if (query.employeeId) qb = qb.eq('created_by', query.employeeId);
    if (query.olderThanHours !== undefined) {
      const cutoff = new Date(now.getTime() - query.olderThanHours * HOUR_MS);
      qb = qb.lt('created_at', cutoff.toISOString());
    }

    if (query.cursor) {
      const c = decodeCursor(query.cursor, 'approval-queue');
      qb = qb.or(
        `created_at.gt.${c.createdAt},and(created_at.eq.${c.createdAt},id.gt.${c.id})`,
      );
    }

    const pageSize = query.limit ?? PAGE_SIZE;
    const { data, error } = await qb
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(pageSize + 1);

    if (error) {
      this.logger.error('Failed to list approval queue:', { error });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to load the approval queue',
      });
    }

    const rows = (data ?? []) as unknown as QueueRow[];
    const hasMore = rows.length > pageSize;
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
    const last = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor(last.id, last.created_at, 'approval-queue')
        : null;

    return new PaginatedResponse(
      pageRows.map((r) => this.toItem(r, now)),
      nextCursor,
    );
  }

  private toItem(row: QueueRow, now: Date): ApprovalQueueItem {
    const creator = first(row.creator);
    return {
      id: row.id,
      jobNumber: row.job_number,
      submittedAt: row.created_at,
      ageHours: Math.floor(
        (now.getTime() - Date.parse(row.created_at)) / HOUR_MS,
      ),
      employee:
        row.created_by === null
          ? null
          : { id: row.created_by, name: creator?.name ?? null },
      customerName: first(row.customers)?.name ?? null,
    };
  }
}
