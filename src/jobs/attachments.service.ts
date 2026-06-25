import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpStatus,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { StorageService } from '../storage/storage.service';
import { ErrorCode } from '../common/enums/error-code.enum';
import { RequestUser } from '../common/interfaces/request-user.interface';
import {
  UploadAttachmentDto,
  AttachmentType,
} from './dto/upload-attachment.dto';
import { ConfirmAttachmentDto } from './dto/confirm-attachment.dto';

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
};

const PRESIGNED_TTL_SECONDS = 900; // 15 minutes
// Upper bound on the client-reported attachment size. Configurable via
// MAX_ATTACHMENT_SIZE_BYTES; defaults to 50 MB. Keeps stored size_bytes within
// the INT column (max 2,147,483,647) so an oversized/forged value returns a
// clean 422 instead of overflowing the column into an opaque 500.
const DEFAULT_MAX_ATTACHMENT_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB

interface AttachmentJobRow {
  id: string;
  tenant_id: string;
  technician_id: string;
}

interface ConfirmRpcRow {
  attachment_id: string;
  attachment_type: string;
  created_at: string;
  already_existed: boolean;
}

@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name);

  private readonly maxAttachmentSizeBytes: number;

  constructor(
    private readonly supabaseClientFactory: SupabaseClientFactory,
    private readonly storageService: StorageService,
    private readonly configService: ConfigService,
  ) {
    const configured = this.configService.get<number>(
      'MAX_ATTACHMENT_SIZE_BYTES',
    );
    this.maxAttachmentSizeBytes =
      configured && configured > 0
        ? configured
        : DEFAULT_MAX_ATTACHMENT_SIZE_BYTES;
  }

  async requestUpload(
    user: RequestUser,
    jobId: string,
    dto: UploadAttachmentDto,
  ): Promise<{
    presignedPutUrl: string;
    uploadId: string;
    key: string;
    expiresAt: string;
  }> {
    if (!user.tenantId) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Company setup required',
      });
    }

    const admin = this.supabaseClientFactory.createAdmin();

    const { data: job, error: jobError } = await admin
      .from('jobs')
      .select('id, tenant_id, technician_id')
      .eq('id', jobId)
      .eq('tenant_id', user.tenantId)
      .single<AttachmentJobRow>();

    if (jobError && jobError.code !== 'PGRST116') {
      this.logger.error('Failed to fetch job for attachment upload:', {
        error: jobError,
      });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to request upload',
      });
    }
    if (!job) {
      throw new NotFoundException({
        error_code: ErrorCode.RESOURCE_NOT_FOUND,
        message: 'Job not found',
      });
    }

    if (job.technician_id !== user.userId) {
      throw new ForbiddenException({
        error_code: ErrorCode.FORBIDDEN,
        message: 'Forbidden',
      });
    }

    if (dto.attachmentType === AttachmentType.PHOTO) {
      const { count, error: countError } = await admin
        .from('attachments')
        .select('id', { count: 'exact', head: true })
        .eq('job_id', jobId)
        .eq('tenant_id', user.tenantId)
        .eq('attachment_type', 'photo');

      if (countError) {
        this.logger.error('Failed to count confirmed photos:', {
          error: countError,
        });
        throw new InternalServerErrorException({
          error_code: ErrorCode.INTERNAL_SERVER_ERROR,
          message: 'Failed to request upload',
        });
      }

      if ((count ?? 0) >= 5) {
        this.logger.warn(
          `Photo limit reached for job ${jobId}: count=${count}`,
        );
        throw new ConflictException({
          error_code: ErrorCode.DUPLICATE_RESOURCE,
          message: 'Maximum of 5 photos already uploaded',
        });
      }
    }

    const ext = MIME_TO_EXT[dto.mimeType];
    const uuid = crypto.randomUUID();
    const folder =
      dto.attachmentType === AttachmentType.PHOTO ? 'photos' : 'signature';
    const key = `${user.tenantId}/jobs/${jobId}/${folder}/${uuid}.${ext}`;
    const expiresAt = new Date(
      Date.now() + PRESIGNED_TTL_SECONDS * 1000,
    ).toISOString();

    const presignedPutUrl = await this.storageService.getPresignedUploadUrl(
      key,
      dto.mimeType,
      PRESIGNED_TTL_SECONDS,
    );

    const { error: insertError } = await admin
      .from('attachment_uploads')
      .insert({
        id: uuid,
        job_id: jobId,
        tenant_id: user.tenantId,
        r2_key: key,
        attachment_type: dto.attachmentType,
        mime_type: dto.mimeType,
        status: 'pending',
        expires_at: expiresAt,
      });

    if (insertError) {
      this.logger.error('Failed to insert attachment_uploads staging row:', {
        error: insertError,
      });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to request upload',
      });
    }

    this.logger.log(
      `Upload requested: uploadId=${uuid}, type=${dto.attachmentType}, job=${jobId}`,
    );
    return { presignedPutUrl, uploadId: uuid, key, expiresAt };
  }

  async confirmUpload(
    user: RequestUser,
    jobId: string,
    uploadId: string,
    dto: ConfirmAttachmentDto,
  ): Promise<{ id: string; type: string; createdAt: string }> {
    if (!user.tenantId) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Company setup required',
      });
    }

    // Bound the client-reported size so it stays within the INT column and a
    // forged/oversized value returns 422 rather than overflowing into a 500.
    if (dto.sizeBytes > this.maxAttachmentSizeBytes) {
      throw new BadRequestException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: `File size exceeds the maximum of ${this.maxAttachmentSizeBytes} bytes`,
      });
    }

    const admin = this.supabaseClientFactory.createAdmin();

    const { data: job, error: jobError } = await admin
      .from('jobs')
      .select('id, tenant_id, technician_id')
      .eq('id', jobId)
      .eq('tenant_id', user.tenantId)
      .single<AttachmentJobRow>();

    if (jobError && jobError.code !== 'PGRST116') {
      this.logger.error('Failed to fetch job for attachment confirm:', {
        error: jobError,
      });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to confirm upload',
      });
    }
    if (!job) {
      throw new NotFoundException({
        error_code: ErrorCode.RESOURCE_NOT_FOUND,
        message: 'Job not found',
      });
    }

    if (job.technician_id !== user.userId) {
      throw new ForbiddenException({
        error_code: ErrorCode.FORBIDDEN,
        message: 'Forbidden',
      });
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data: rows, error: rpcError } = await admin.rpc(
      'confirm_attachment',
      {
        p_upload_id: uploadId,
        p_job_id: jobId,
        p_tenant_id: user.tenantId,
        p_size_bytes: dto.sizeBytes,
        p_actor_id: user.userId,
      },
    );

    if (rpcError) {
      const msg = rpcError.message ?? '';
      if (msg.includes('UPLOAD_NOT_FOUND')) {
        throw new NotFoundException({
          error_code: ErrorCode.RESOURCE_NOT_FOUND,
          message: 'Upload not found',
        });
      }
      if (msg.includes('UPLOAD_EXPIRED')) {
        this.logger.warn(
          `Expired upload confirm attempt: uploadId=${uploadId}`,
        );
        throw new HttpException(
          {
            error_code: 'UPLOAD_EXPIRED',
            message: 'Upload session expired — request a new presigned URL',
          },
          HttpStatus.GONE,
        );
      }
      if (msg.includes('PHOTO_LIMIT_EXCEEDED')) {
        this.logger.warn(`Photo limit hit at confirm time for job ${jobId}`);
        throw new ConflictException({
          error_code: ErrorCode.DUPLICATE_RESOURCE,
          message: 'Maximum of 5 photos already uploaded',
        });
      }
      this.logger.error('confirm_attachment RPC failed:', { error: rpcError });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to confirm upload',
      });
    }

    const row = (rows as ConfirmRpcRow[])[0];
    // The RPC always RETURN QUERYs exactly one row on the success path; an
    // empty/absent result means a dangling confirmed staging row (its
    // attachments row was cleaned up) — treat as 404 rather than dereferencing
    // undefined into an opaque 500.
    if (!row || !row.attachment_id) {
      this.logger.error(
        `confirm_attachment returned no attachment row for uploadId=${uploadId}`,
      );
      throw new NotFoundException({
        error_code: ErrorCode.RESOURCE_NOT_FOUND,
        message: 'Upload not found',
      });
    }
    this.logger.log(
      `Upload confirmed: uploadId=${uploadId}, type=${row.attachment_type}, job=${jobId}`,
    );
    return {
      id: row.attachment_id,
      type: row.attachment_type,
      createdAt: row.created_at,
    };
  }
}
