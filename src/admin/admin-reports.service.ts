import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { ErrorCode } from '../common/enums/error-code.enum';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { StorageService } from '../storage/storage.service';
import type {
  ReportQueueStatus,
  ResolveAction,
} from './dto/attachment-reports.dto';

/** Same lifetime as the photo links in job detail. */
const PHOTO_URL_TTL_SECONDS = 3600;
const QUEUE_LIMIT = 50;

export interface AdminReportItem {
  id: string;
  jobId: string;
  attachmentId: string;
  reason: string;
  note: string | null;
  status: string;
  photoHidden: boolean;
  photoUrl: string | null;
  createdAt: string;
}

interface QueueRow {
  id: string;
  reason: string;
  note: string | null;
  status: string;
  created_at: string;
  attachment_id: string;
  attachments: { job_id: string; r2_key: string; hidden_at: string | null };
}

interface ResolveRow {
  id: string;
  status: string;
  attachment_id: string;
  attachments: { job_id: string };
}

/**
 * Platform-admin side of photo reports. Staff act across every company, so
 * this uses the admin client (no tenant filter), like the other admin
 * services. Every write is safe to repeat.
 */
@Injectable()
export class AdminReportsService {
  private readonly logger = new Logger(AdminReportsService.name);

  constructor(
    private readonly supabaseClientFactory: SupabaseClientFactory,
    private readonly storageService: StorageService,
  ) {}

  async list(status: ReportQueueStatus = 'open'): Promise<AdminReportItem[]> {
    const admin = this.supabaseClientFactory.createAdmin();
    const { data, error } = await admin
      .from('attachment_reports')
      .select(
        'id, reason, note, status, created_at, attachment_id, attachments!inner(job_id, r2_key, hidden_at)',
      )
      .eq('status', status)
      .order('created_at', { ascending: true })
      .limit(QUEUE_LIMIT)
      .returns<QueueRow[]>();
    if (error) {
      this.logger.error('Failed to load photo report queue:', { error });
      throw this.internal('Failed to load reports');
    }

    // Sign each photo in isolation: one storage failure must not hide the
    // whole queue. A null url tells the reviewer the photo could not load.
    return Promise.all(
      (data ?? []).map(async (row) => {
        let photoUrl: string | null = null;
        try {
          photoUrl = await this.storageService.getPresignedReadUrl(
            row.attachments.r2_key,
            PHOTO_URL_TTL_SECONDS,
          );
        } catch (err) {
          this.logger.error('Failed to sign reported photo URL', {
            reportId: row.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return {
          id: row.id,
          jobId: row.attachments.job_id,
          attachmentId: row.attachment_id,
          reason: row.reason,
          note: row.note,
          status: row.status,
          photoHidden: row.attachments.hidden_at !== null,
          photoUrl,
          createdAt: row.created_at,
        };
      }),
    );
  }

  async resolve(
    reviewer: RequestUser,
    reportId: string,
    action: ResolveAction,
  ): Promise<{ id: string; status: string }> {
    const admin = this.supabaseClientFactory.createAdmin();

    const { data: report, error: readError } = await admin
      .from('attachment_reports')
      .select('id, status, attachment_id, attachments!inner(job_id)')
      .eq('id', reportId)
      .maybeSingle<ResolveRow>();
    if (readError) {
      this.logger.error('Failed to read report for resolve:', {
        error: readError,
      });
      throw this.internal('Failed to resolve report');
    }
    if (!report) {
      throw new NotFoundException({
        error_code: ErrorCode.RESOURCE_NOT_FOUND,
        message: 'Report not found',
      });
    }
    if (report.status !== 'open') {
      throw new ConflictException({
        error_code: ErrorCode.REPORT_ALREADY_RESOLVED,
        message: 'Report already resolved',
      });
    }

    const now = new Date().toISOString();
    const nextStatus = action === 'hide' ? 'hidden' : 'dismissed';

    if (action === 'hide') {
      // Side effects first, all idempotent, so a retry after a partial
      // failure finishes the job. Claiming the report comes last.
      const { error: hideError } = await admin
        .from('attachments')
        .update({ hidden_at: now })
        .eq('id', report.attachment_id)
        .is('hidden_at', null);
      if (hideError) throw this.internal('Failed to hide photo');

      // Hidden photos leave devices only on a delta sync, and sync picks
      // jobs by updated_at, so bump it.
      const { error: touchError } = await admin
        .from('jobs')
        .update({ updated_at: now })
        .eq('id', report.attachments.job_id);
      if (touchError) throw this.internal('Failed to hide photo');

      // Every other open report on this photo is settled by the same call.
      const { error: othersError } = await admin
        .from('attachment_reports')
        .update({ status: 'hidden', reviewed_by: reviewer.userId, reviewed_at: now })
        .eq('attachment_id', report.attachment_id)
        .eq('status', 'open')
        .neq('id', reportId);
      if (othersError) throw this.internal('Failed to resolve report');
    }

    const { data: claimed, error: claimError } = await admin
      .from('attachment_reports')
      .update({ status: nextStatus, reviewed_by: reviewer.userId, reviewed_at: now })
      .eq('id', reportId)
      .eq('status', 'open')
      .select('id')
      .maybeSingle<{ id: string }>();
    if (claimError) {
      this.logger.error('Failed to settle report:', { error: claimError });
      throw this.internal('Failed to resolve report');
    }
    if (!claimed) {
      // Another reviewer settled it between our read and this write.
      throw new ConflictException({
        error_code: ErrorCode.REPORT_ALREADY_RESOLVED,
        message: 'Report already resolved',
      });
    }
    return { id: reportId, status: nextStatus };
  }

  private internal(message: string) {
    return new InternalServerErrorException({
      error_code: ErrorCode.INTERNAL_SERVER_ERROR,
      message,
    });
  }
}
