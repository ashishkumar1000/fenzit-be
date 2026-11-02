import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { ErrorCode } from '../common/enums/error-code.enum';
import { Role } from '../common/enums/role.enum';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { ReportAttachmentDto } from './dto/report-attachment.dto';

export interface AttachmentReportResponse {
  id: string;
  attachmentId: string;
  reason: string;
  status: string;
  createdAt: string;
}

interface ReportRow {
  id: string;
  attachment_id: string;
  reason: string;
  status: string;
  created_at: string;
}

const UNIQUE_VIOLATION = '23505';

/**
 * Lets a user who can open a job report one of its photos. The rule for
 * "can open" matches job detail: same company, and an employee only sees
 * jobs assigned to them. The report never hides the photo; a platform
 * admin does that from the queue.
 */
@Injectable()
export class AttachmentReportsService {
  private readonly logger = new Logger(AttachmentReportsService.name);

  constructor(
    private readonly supabaseClientFactory: SupabaseClientFactory,
  ) {}

  /** Returns `created: false` when this user already reported this photo. */
  async report(
    user: RequestUser,
    jobId: string,
    attachmentId: string,
    dto: ReportAttachmentDto,
  ): Promise<{ report: AttachmentReportResponse; created: boolean }> {
    if (!user.tenantId) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Company setup required before reporting photos',
      });
    }

    const admin = this.supabaseClientFactory.createAdmin();

    const { data: job, error: jobError } = await admin
      .from('jobs')
      .select('id, technician_id')
      .eq('id', jobId)
      .eq('tenant_id', user.tenantId)
      .maybeSingle<{ id: string; technician_id: string }>();
    if (jobError) {
      this.logger.error('Failed to fetch job for photo report:', {
        error: jobError,
      });
      throw this.internal('Failed to report photo');
    }
    if (!job) {
      throw new NotFoundException({
        error_code: ErrorCode.RESOURCE_NOT_FOUND,
        message: 'Job not found',
      });
    }
    if (user.role === Role.EMPLOYEE && job.technician_id !== user.userId) {
      throw new ForbiddenException({
        error_code: ErrorCode.FORBIDDEN,
        message: 'Forbidden',
      });
    }

    const { data: attachment, error: attachError } = await admin
      .from('attachments')
      .select('id')
      .eq('id', attachmentId)
      .eq('job_id', jobId)
      .eq('tenant_id', user.tenantId)
      .is('hidden_at', null)
      .maybeSingle<{ id: string }>();
    if (attachError) {
      this.logger.error('Failed to fetch photo for report:', {
        error: attachError,
      });
      throw this.internal('Failed to report photo');
    }
    if (!attachment) {
      throw new NotFoundException({
        error_code: ErrorCode.RESOURCE_NOT_FOUND,
        message: 'Photo not found',
      });
    }

    const { data: inserted, error: insertError } = await admin
      .from('attachment_reports')
      .insert({
        attachment_id: attachmentId,
        tenant_id: user.tenantId,
        reporter_id: user.userId,
        reason: dto.reason,
        note: dto.note?.trim() || null,
      })
      .select('id, attachment_id, reason, status, created_at')
      .single<ReportRow>();

    if (!insertError && inserted) {
      return { report: this.toResponse(inserted), created: true };
    }
    if (insertError?.code !== UNIQUE_VIOLATION) {
      this.logger.error('Failed to store photo report:', {
        error: insertError,
      });
      throw this.internal('Failed to report photo');
    }

    // Same person reported this photo before: return that report, no new row.
    const { data: existing, error: existingError } = await admin
      .from('attachment_reports')
      .select('id, attachment_id, reason, status, created_at')
      .eq('attachment_id', attachmentId)
      .eq('reporter_id', user.userId)
      .maybeSingle<ReportRow>();
    if (existingError || !existing) {
      this.logger.error('Duplicate report found but could not be read:', {
        error: existingError,
      });
      throw this.internal('Failed to report photo');
    }
    return { report: this.toResponse(existing), created: false };
  }

  private toResponse(row: ReportRow): AttachmentReportResponse {
    return {
      id: row.id,
      attachmentId: row.attachment_id,
      reason: row.reason,
      status: row.status,
      createdAt: row.created_at,
    };
  }

  private internal(message: string) {
    return new InternalServerErrorException({
      error_code: ErrorCode.INTERNAL_SERVER_ERROR,
      message,
    });
  }
}
