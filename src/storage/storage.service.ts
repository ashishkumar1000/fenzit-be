import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(private readonly configService: ConfigService) {
    this.bucket = configService.getOrThrow<string>('CLOUDFLARE_R2_BUCKET');
    const accountId = configService.getOrThrow<string>(
      'CLOUDFLARE_R2_ACCOUNT_ID',
    );
    const accessKeyId = configService.getOrThrow<string>(
      'CLOUDFLARE_R2_ACCESS_KEY',
    );
    const secretAccessKey = configService.getOrThrow<string>(
      'CLOUDFLARE_R2_SECRET_KEY',
    );

    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  async getPresignedUploadUrl(
    key: string,
    contentType: string,
    ttlSeconds: number,
  ): Promise<string> {
    this.logger.log(
      `Generating presigned upload URL: key=${key}, ttl=${ttlSeconds}s`,
    );
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
      { expiresIn: ttlSeconds, signableHeaders: new Set(['content-type']) },
    );
  }

  /**
   * Check file existence via HeadObject (5s timeout), then return presigned URL.
   * Throws NotFound for 404 (file missing); rethrows 5xx/timeout as transient error.
   */
  async getPresignedReadUrl(key: string, ttlSeconds: number): Promise<string> {
    // Verify file exists before presigning (5s timeout).
    await this.verifyObjectExists(key);
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: ttlSeconds },
    );
  }

  private async verifyObjectExists(key: string): Promise<void> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
        { abortSignal: controller.signal },
      );
    } catch (err) {
      clearTimeout(timeoutId);
      // Preserve NotFound for client to map to 410; rethrow other errors.
      if (err instanceof NotFound) {
        throw err;
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Server-side upload — the backend itself writes the object (no presigned
   * URL hop). Used by the report worker to store generated PDFs
   * (Epic 12); the report pipeline uploads strictly before stamping `ready`.
   */
  async putObject(
    key: string,
    contentType: string,
    body: Buffer,
  ): Promise<void> {
    this.logger.log(`Uploading object: key=${key}, bytes=${body.length}`);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
        Body: body,
      }),
    );
  }
}
