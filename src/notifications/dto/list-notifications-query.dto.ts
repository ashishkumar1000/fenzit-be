import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { trimToUndefined } from '../../common/utils/trim.transformer';

export class ListNotificationsQueryDto {
  @ApiPropertyOptional({
    description: 'Opaque pagination cursor from a previous response',
  })
  @IsOptional()
  @Transform(trimToUndefined)
  @IsString()
  @MaxLength(512)
  cursor?: string;

  @ApiPropertyOptional({
    example: 20,
    description:
      'Max notifications to return (1-50). Defaults to 20 if omitted.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
