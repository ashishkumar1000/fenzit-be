import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { trim } from '../../common/utils/trim.transformer';
import { TECHNICIAN_JOB_ACTIVITY_TYPE } from '../registry/technician-job-activity.definition';

/**
 * Create a report request. Deep validation (calendar dates, 92-day cap, IST
 * future check, technician membership) lives in the report definition +
 * service — the DTO only pins shape, so every failure maps to a 400 carrying
 * the specific error code rather than a generic 422.
 */
export class CreateReportRequestDto {
  @ApiPropertyOptional({
    default: TECHNICIAN_JOB_ACTIVITY_TYPE,
    description: 'Report type from the registry. Defaults to the first report.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(64)
  reportType?: string;

  @ApiProperty({
    example: '2026-09-01',
    description: 'Range start, calendar date YYYY-MM-DD, inclusive.',
  })
  @Transform(trim)
  @IsString()
  @MaxLength(10)
  startDate: string;

  @ApiProperty({
    example: '2026-09-15',
    description:
      'Range end, calendar date YYYY-MM-DD, inclusive. Not in the future (IST clock).',
  })
  @Transform(trim)
  @IsString()
  @MaxLength(10)
  endDate: string;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Technician ids to scope the report to. Absent or empty = all technicians of the company. Max 25.',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  technicianIds?: string[] | null;
}
