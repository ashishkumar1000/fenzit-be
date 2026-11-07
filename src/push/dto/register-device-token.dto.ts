import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, Length } from 'class-validator';
import { trim } from '../../common/utils/trim.transformer';

/** The only platforms a push is wired for today (stack.md device table). */
export const DEVICE_TOKEN_PLATFORMS = ['android', 'ios'] as const;

export type DeviceTokenPlatform = (typeof DEVICE_TOKEN_PLATFORMS)[number];

export class RegisterDeviceTokenDto {
  @ApiProperty({
    description:
      "FCM registration token. Bound to the JWT's user — the body never carries a user id.",
  })
  // Trim through the shared trimmer (never a local copy) — a padded token
  // would be stored padded and then never match the raw FCM token again.
  @Transform(trim)
  @IsString()
  // FCM tokens run ~150 chars; 4096 is the safe upper bound (the 4 KB
  // per-message budget the token rides inside).
  @Length(1, 4096)
  token!: string;

  @ApiProperty({ enum: DEVICE_TOKEN_PLATFORMS })
  @IsIn(DEVICE_TOKEN_PLATFORMS)
  platform!: DeviceTokenPlatform;

  @ApiPropertyOptional({
    description: "The app's installed version, when known",
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 64)
  appVersion?: string;
}
