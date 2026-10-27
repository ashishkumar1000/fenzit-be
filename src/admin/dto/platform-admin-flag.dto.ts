import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class PlatformAdminFlagDto {
  @ApiProperty({
    description: 'true promotes the person to platform admin (staff), false demotes them',
  })
  @IsBoolean()
  value: boolean;
}
