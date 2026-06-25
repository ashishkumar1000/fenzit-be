import {
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { ErrorCode } from '../common/enums/error-code.enum';
import { StorageEventDto } from './dto/storage-event.dto';

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly supabaseClientFactory: SupabaseClientFactory,
    private readonly configService: ConfigService,
  ) {}

  async handleStorageEvent(
    authHeader: string | undefined,
    dto: StorageEventDto,
  ): Promise<void> {
    const expected = this.configService.getOrThrow<string>(
      'WORKER_WEBHOOK_SECRET',
    );
    const token = authHeader?.replace('Bearer ', '') ?? '';

    // Timing-safe comparison prevents secret-length leakage
    const tokenBuf = Buffer.from(token);
    const expectedBuf = Buffer.from(expected);
    if (
      tokenBuf.length !== expectedBuf.length ||
      !timingSafeEqual(tokenBuf, expectedBuf)
    ) {
      this.logger.warn('Webhook auth failed: invalid or missing secret');
      throw new UnauthorizedException({
        error_code: ErrorCode.UNAUTHORIZED,
        message: 'Unauthorized',
      });
    }

    // Parse uploadId from key: {tenantId}/jobs/{jobId}/{folder}/{uuid}.{ext}
    const parts = dto.key.split('/');
    const uploadId = parts[4]?.split('.')[0];

    if (!uploadId) {
      this.logger.warn(
        `Webhook: could not parse uploadId from key: ${dto.key}`,
      );
      return;
    }

    // Defense-in-depth: the tenant/job scoping must come from the key path, not
    // from independently-supplied body fields. Reject if the body's tenantId/
    // jobId disagree with the key segments (parts[0]=tenantId, parts[2]=jobId).
    // The RPC's WHERE clause would 404 a mismatch anyway, but fail fast here so
    // a malformed/forged payload is logged rather than silently acked as
    // "not found".
    if (
      !dto.key.startsWith(`${dto.tenantId}/jobs/${dto.jobId}/`) ||
      parts[1] !== 'jobs'
    ) {
      this.logger.warn(
        `Webhook: key/body mismatch — key=${dto.key} tenantId=${dto.tenantId} jobId=${dto.jobId}`,
      );
      return;
    }

    const admin = this.supabaseClientFactory.createAdmin();

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data: rows, error: rpcError } = await admin.rpc(
      'confirm_attachment',
      {
        p_upload_id: uploadId,
        p_job_id: dto.jobId,
        p_tenant_id: dto.tenantId,
        p_size_bytes: dto.size,
        p_actor_id: null,
      },
    );

    if (rpcError) {
      const msg = rpcError.message ?? '';
      if (msg.includes('UPLOAD_NOT_FOUND')) {
        this.logger.warn(
          `Webhook: upload not found (already deleted?): uploadId=${uploadId}`,
        );
        return; // Ack — retrying won't help
      }
      if (msg.includes('UPLOAD_EXPIRED')) {
        this.logger.warn(`Webhook: upload expired: uploadId=${uploadId}`);
        return; // Ack — retrying won't help
      }
      if (msg.includes('PHOTO_LIMIT_EXCEEDED')) {
        this.logger.warn(
          `Webhook: photo limit hit: uploadId=${uploadId}, job=${dto.jobId}`,
        );
        return; // Ack — retrying won't help
      }
      this.logger.error('confirm_attachment RPC failed in webhook:', {
        error: rpcError,
      });
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to process storage event',
      });
    }

    const row = (
      rows as { attachment_id: string; attachment_type: string }[]
    )[0];
    this.logger.log(
      `Webhook confirm succeeded: uploadId=${uploadId}, type=${row?.attachment_type}`,
    );
  }
}
