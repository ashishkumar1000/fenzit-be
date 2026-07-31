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

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class GetProfileQueryDto {
  @ApiPropertyOptional({
    description:
      'Opaque pagination cursor for the jobs list, from a previous response',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(512)
  jobsCursor?: string;

  @ApiPropertyOptional({
    description:
      'Opaque pagination cursor for the customers list (owner only), from a previous response',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(512)
  customersCursor?: string;

  @ApiPropertyOptional({
    example: 5,
    description: 'Max jobs to return (1-50). Defaults to 50 if omitted.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  jobsLimit?: number;

  @ApiPropertyOptional({
    example: 5,
    description:
      'Max customers to return (1-50, owner only). Defaults to 50 if omitted.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  customersLimit?: number;
}
