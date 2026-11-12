import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { trim } from '../../common/utils/trim.transformer';

/**
 * Approval queue filters (story 6, CAP-10). Filters combine: an employee and an
 * age cut-off together show that employee's jobs older than the cut-off.
 */
export class ApprovalQueueQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Show only jobs this employee created.',
  })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiPropertyOptional({
    example: 24,
    description:
      'Show only jobs submitted more than this many hours ago (1-8760).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(8760)
  olderThanHours?: number;

  @ApiPropertyOptional({
    description: 'Opaque cursor from a previous response',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(512)
  cursor?: string;

  @ApiPropertyOptional({
    example: 20,
    description: 'Max jobs to return (1-50). Defaults to 50.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
