import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsDefined,
  IsEmail,
  IsString,
  IsUrl,
  Length,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { trim } from '../../common/utils/trim.transformer';

const SEMVER_DIGITS = /^\d+\.\d+\.\d+$/;
/** Plain text only: no angle brackets, no control characters (newlines too). */
const PLAIN_TEXT = /^[^<>\p{Cc}]+$/u;
/** Digits with an optional leading +, spaces allowed between digits. */
const PHONE_SHAPE = /^\+?[0-9][0-9 ]*$/;

/** The version and message rules shared by both platforms. */
class PlatformRoadblockBaseDto {
  @ApiProperty({ example: '1.5.0', description: 'Digits only, x.y.z' })
  @Transform(trim)
  @IsString()
  @Matches(SEMVER_DIGITS, { message: 'minVersion must look like 1.5.0' })
  @MaxLength(20)
  minVersion: string;

  @ApiProperty({ example: 'Please update the Fenzit app to continue.' })
  @Transform(trim)
  @IsString()
  @Length(1, 500)
  @Matches(PLAIN_TEXT, { message: 'message must be plain text' })
  message: string;
}

/** Android rule: the store link must be on play.google.com. */
export class AndroidRoadblockDto extends PlatformRoadblockBaseDto {
  @ApiProperty({
    example: 'https://play.google.com/store/apps/details?id=com.fenzit',
  })
  @Transform(trim)
  @IsUrl(
    {
      protocols: ['https'],
      require_protocol: true,
      require_tld: true,
      host_whitelist: ['play.google.com'],
    },
    { message: 'storeUrl must be an https link to play.google.com' },
  )
  @MaxLength(300)
  storeUrl: string;
}

/** iOS rule: the store link must be on apps.apple.com. */
export class IosRoadblockDto extends PlatformRoadblockBaseDto {
  @ApiProperty({ example: 'https://apps.apple.com/app/id0000000000' })
  @Transform(trim)
  @IsUrl(
    {
      protocols: ['https'],
      require_protocol: true,
      require_tld: true,
      host_whitelist: ['apps.apple.com'],
    },
    { message: 'storeUrl must be an https link to apps.apple.com' },
  )
  @MaxLength(300)
  storeUrl: string;
}

export class SupportContactDto {
  @ApiProperty({ example: 'hello@fenzit.com' })
  @Transform(trim)
  @IsEmail({ require_tld: true })
  @MaxLength(254)
  email: string;

  @ApiProperty({ example: '+91 92792 30451' })
  @Transform(trim)
  @IsString()
  @Length(7, 20)
  @Matches(PHONE_SHAPE, {
    message: 'phone must be digits with an optional leading +',
  })
  phone: string;
}

/** PUT /admin/config/app-roadblocks: the full set, replaced in one write. */
export class AppRoadblocksConfigDto {
  @ApiProperty({ type: AndroidRoadblockDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => AndroidRoadblockDto)
  android: AndroidRoadblockDto;

  @ApiProperty({ type: IosRoadblockDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => IosRoadblockDto)
  ios: IosRoadblockDto;

  @ApiProperty({ type: SupportContactDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => SupportContactDto)
  support: SupportContactDto;
}
