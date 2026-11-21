import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { trim } from '../../common/utils/trim.transformer';
import { JobStatus } from '../enums/job-status.enum';
import { JobPriority } from '../enums/job-priority.enum';

const SORTS = ['latest', 'soonest'] as const;

type Sort = (typeof SORTS)[number];

/**
 * Query for GET /jobs/page — the web console's paged jobs table. Every filter
 * is optional; with none, the list is every job in the company, newest created
 * first.
 *
 * Filtering, sorting and paging happen in the DATABASE (the jobs_overview
 * view flattens the customer / technician / skill names into bare columns) —
 * a company's job history grows without bound, so the list can never be
 * loaded whole. `search` matches the job's own words, its number, its place,
 * and the names of its customer, employee and skill, all case-insensitive
 * "contains".
 */
export class JobsPageQueryDto {
  @ApiPropertyOptional({ example: 1, default: 1, maximum: 10000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  // A ceiling keeps an astronomic hand-edited page (1e21) from pushing the
  // range bound past 2^53, where PostgREST rejects the request shape entirely
  // and the endpoint would answer 500 instead of an empty page.
  @Max(10000)
  page?: number;

  @ApiPropertyOptional({ example: 10, default: 10, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;

  @ApiPropertyOptional({
    example: 'sharma',
    description:
      'Matches the job number, description, place, or the customer, employee or skill name — case-insensitive "contains".',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  search?: string;

  @ApiPropertyOptional({
    enum: JobStatus,
    description: 'Filter to one status of the job lifecycle.',
  })
  @IsOptional()
  @Transform(trim)
  @IsEnum(JobStatus)
  status?: JobStatus;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Filter to one skill from the global catalog.',
  })
  @IsOptional()
  @IsUUID('loose') // never '4'/'all' — real ids fail 'all' (see leave.dto.ts)
  skillId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Filter to one employee’s jobs (the profile page’s Jobs tab). When set, `stats` describes THAT employee’s jobs, not the whole company.',
  })
  @IsOptional()
  @IsUUID('loose')
  technicianId?: string;

  @ApiPropertyOptional({
    enum: JobPriority,
    description: 'Filter to one dispatch priority.',
  })
  @IsOptional()
  @Transform(trim)
  @IsEnum(JobPriority)
  priority?: JobPriority;

  @ApiPropertyOptional({
    enum: SORTS,
    default: 'latest',
    description:
      'latest = newest created first (default); soonest = earliest scheduled start first, jobs with no date last.',
  })
  @IsOptional()
  @Transform(trim)
  @IsIn(SORTS, { message: 'sort must be latest or soonest' })
  sort?: Sort;
}
