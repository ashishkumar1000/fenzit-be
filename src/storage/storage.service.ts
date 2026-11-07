import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
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

  /**
   * Presigned read URL with NO existence check — for keys the backend already
   * confirmed (e.g. a profile photo stored after its upload was verified).
   * Signing is local, so this adds no network call to the caller.
   */
  async presignReadUrl(key: string, ttlSeconds: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: ttlSeconds },
    );
  }

  /**
   * Size and content type of a stored object, or null when no object exists
   * at the key. Used to check an upload really arrived and is the right size.
   */
  async getObjectMeta(key: string): Promise<{
    contentLength: number;
    contentType: string | undefined;
  } | null> {
    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        contentLength: head.ContentLength ?? 0,
        contentType: head.ContentType,
      };
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } })
        .$metadata?.httpStatusCode;
      if (status === 404) return null;
      throw err;
    }
  }

  /** Best-effort delete. A failure is logged, never thrown: the caller's
   *  change has already been saved, and a stray object is harmless. */
  async deleteObject(key: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (err) {
      this.logger.warn(`Could not delete object: key=${key}`, err);
    }
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
      // Rethrow as-is — the client maps the SDK's NotFound (404) to 410 and
      // treats other errors as transient. (A previous `instanceof NotFound`
      // branch here was dead code: both arms threw err, and the check itself
      // crashes under jest's CJS interop where the ESM class binding is
      // undefined.)
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
