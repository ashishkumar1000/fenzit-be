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
import { trim, trimToUndefined } from '../../common/utils/trim.transformer';

export class ListCustomersQueryDto {
  @ApiPropertyOptional({
    example: 'priya',
    description:
      'Case-insensitive partial match on customer name or phone number',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  q?: string;

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
    description: 'Max customers to return (1-50). Defaults to 50 if omitted.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
