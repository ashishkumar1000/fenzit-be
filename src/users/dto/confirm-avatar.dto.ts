import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

export class ConfirmAvatarDto {
  @ApiProperty({
    example:
      'avatars/0f1e2d3c-4b5a-4968-8778-6f5e4d3c2b1a/9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d.jpg',
    description:
      'The key returned by POST /users/me/avatar/upload-url, after the upload finished.',
  })
  @IsString()
  @Matches(/^avatars\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png)$/)
  key: string;
}
