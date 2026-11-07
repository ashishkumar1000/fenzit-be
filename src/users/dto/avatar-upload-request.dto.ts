import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, Max, Min } from 'class-validator';
import {
  AVATAR_MAX_BYTES,
  AVATAR_MIME_TO_EXT,
  type AvatarMimeType,
} from '../avatar.constants';

export class AvatarUploadRequestDto {
  @ApiProperty({ enum: Object.keys(AVATAR_MIME_TO_EXT), example: 'image/jpeg' })
  @IsIn(Object.keys(AVATAR_MIME_TO_EXT))
  mimeType: AvatarMimeType;

  @ApiProperty({
    example: 512000,
    description: 'Size of the photo in bytes. Must be 2 MB or less.',
  })
  @IsInt()
  @Min(1)
  @Max(AVATAR_MAX_BYTES)
  sizeBytes: number;
}
