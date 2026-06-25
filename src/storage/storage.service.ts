import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
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

  async getPresignedReadUrl(key: string, ttlSeconds: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: ttlSeconds },
    );
  }
}
