import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, Length } from 'class-validator';
import { trim } from '../../common/utils/trim.transformer';

/**
 * The DELETE /device-tokens/:token path parameter. Same bounds as the
 * register DTO's token — a delete of an oversized/malformed token is a 422,
 * not a silent no-op, so the client learns its request never made sense.
 */
export class DeviceTokenParamDto {
  @ApiProperty({ description: 'The FCM token to delete (own rows only)' })
  @Transform(trim)
  @IsString()
  @Length(1, 4096)
  token!: string;
}
