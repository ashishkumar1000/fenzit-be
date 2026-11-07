import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { StorageService } from '../storage/storage.service';
import { ErrorCode } from '../common/enums/error-code.enum';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { AvatarUploadRequestDto } from './dto/avatar-upload-request.dto';
import {
  AVATAR_MAX_BYTES,
  AVATAR_MIME_TO_EXT,
  AVATAR_UPLOAD_TTL_SECONDS,
} from './avatar.constants';

interface AvatarOwnerRow {
  avatar_key: string | null;
}

/**
 * A person's own profile photo. The app uploads straight to storage with a
 * presigned link, then confirms here. The confirm step is where the photo is
 * checked (owner, type, size) — the client's word is never enough.
 */
@Injectable()
export class AvatarService {
  private readonly logger = new Logger(AvatarService.name);

  constructor(
    private readonly supabaseClientFactory: SupabaseClientFactory,
    private readonly storageService: StorageService,
  ) {}

  async requestUpload(user: RequestUser, dto: AvatarUploadRequestDto) {
    const ext = AVATAR_MIME_TO_EXT[dto.mimeType];
    // Keyed under the caller's own id, so a confirm can check ownership.
    const key = `avatars/${user.userId}/${randomUUID()}.${ext}`;
    const uploadUrl = await this.storageService.getPresignedUploadUrl(
      key,
      dto.mimeType,
      AVATAR_UPLOAD_TTL_SECONDS,
    );
    return {
      uploadUrl,
      key,
      expiresAt: new Date(
        Date.now() + AVATAR_UPLOAD_TTL_SECONDS * 1000,
      ).toISOString(),
      maxBytes: AVATAR_MAX_BYTES,
    };
  }

  /**
   * Stores the uploaded photo as the caller's avatar. Rejects (and deletes the
   * object) when the file is the wrong type or size. The old photo is removed
   * once the new key is saved.
   */
  async confirmUpload(user: RequestUser, key: string): Promise<void> {
    if (!key.startsWith(`avatars/${user.userId}/`)) {
      throw new ForbiddenException({
        error_code: ErrorCode.FORBIDDEN,
        message: 'Forbidden',
      });
    }

    const expectedType = key.endsWith('.png') ? 'image/png' : 'image/jpeg';
    const meta = await this.storageService.getObjectMeta(key);
    if (!meta) {
      throw new NotFoundException({
        error_code: ErrorCode.RESOURCE_NOT_FOUND,
        message: 'Photo not found. Upload it first.',
      });
    }
    if (
      meta.contentLength < 1 ||
      meta.contentLength > AVATAR_MAX_BYTES ||
      meta.contentType !== expectedType
    ) {
      await this.storageService.deleteObject(key);
      throw new UnprocessableEntityException({
        error_code: ErrorCode.VALIDATION_ERROR,
        message: 'Photo must be a JPEG or PNG, 2 MB or smaller',
      });
    }

    const admin = this.supabaseClientFactory.createAdmin();
    const { data: owner, error: readError } = await admin
      .from('users')
      .select('avatar_key')
      .eq('id', user.userId)
      .single<AvatarOwnerRow>();
    if (readError || !owner) {
      this.logger.error('Failed to read current avatar:', { error: readError });
      await this.storageService.deleteObject(key);
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to save photo',
      });
    }

    const { error: writeError } = await admin
      .from('users')
      .update({ avatar_key: key })
      .eq('id', user.userId);
    if (writeError) {
      this.logger.error('Failed to save avatar key:', { error: writeError });
      await this.storageService.deleteObject(key);
      throw new InternalServerErrorException({
        error_code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Failed to save photo',
      });
    }

    if (owner.avatar_key && owner.avatar_key !== key) {
      await this.storageService.deleteObject(owner.avatar_key);
    }
  }
}
