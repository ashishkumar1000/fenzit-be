import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { trim } from '../../common/utils/trim.transformer';

/** An employee's own pending jobs: cursor and page size only (CAP-4, CAP-9). */
export class OwnPendingQueryDto {
  @ApiPropertyOptional({ description: 'Opaque cursor from a previous response' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(512)
  cursor?: string;

  @ApiPropertyOptional({ example: 20, description: 'Max jobs to return (1-50).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
