import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsIn, IsNotEmpty, IsString } from 'class-validator';

export enum AttachmentType {
  PHOTO = 'photo',
  SIGNATURE = 'signature',
}

export class UploadAttachmentDto {
  @ApiProperty({ example: 'photo1.jpg' })
  @IsString()
  @IsNotEmpty()
  filename: string;

  @ApiProperty({ enum: ['image/jpeg', 'image/png', 'image/heic'] })
  @IsIn(['image/jpeg', 'image/png', 'image/heic'])
  mimeType: string;

  @ApiProperty({ enum: AttachmentType })
  @IsEnum(AttachmentType)
  attachmentType: AttachmentType;
}
