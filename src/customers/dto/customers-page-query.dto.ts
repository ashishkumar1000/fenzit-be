import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MinLength,
  MaxLength,
  Min,
} from 'class-validator';

const BUCKET_FILTERS = ['all', 'new', 'single', 'repeat'] as const;
const SORTS = [
  'created_new',
  'created_old',
  'name_az',
  'name_za',
  'recent_activity',
] as const;

type BucketFilter = (typeof BUCKET_FILTERS)[number];
type Sort = (typeof SORTS)[number];

/**
 * Query for GET /customers/page — the console's paged customer list. Every
 * filter is optional; with none, the list is every customer, newest first.
 *
 * The buckets are the owner-approved disjoint split over job history (a
 * customer has no status column): `new` = zero jobs, `single` = exactly one,
 * `repeat` = two or more — every customer falls in exactly one bucket, so
 * the counts sum to the total. Filtering, sorting and paging happen in the
 * DATABASE (the customers_overview view carries job_count / last_job_date as
 * real columns) because a company can hold thousands of customers.
 */
export class CustomersPageQueryDto {
  @ApiPropertyOptional({ example: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ example: 10, default: 10, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;

  @ApiPropertyOptional({
    example: 'priya',
    description:
      'Matches the customer name or phone number (digits) — case-insensitive "contains".',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  search?: string;

  @ApiPropertyOptional({
    enum: BUCKET_FILTERS,
    default: 'all',
    description:
      'new = no jobs yet, single = exactly one job, repeat = two or more. Buckets are disjoint — the counts sum to the total.',
  })
  @IsOptional()
  @IsIn(BUCKET_FILTERS, {
    message: 'filter must be all, new, single or repeat',
  })
  filter?: BucketFilter;

  @ApiPropertyOptional({ enum: SORTS, default: 'created_new' })
  @IsOptional()
  @IsIn(SORTS, {
    message:
      'sort must be created_new, created_old, name_az, name_za or recent_activity',
  })
  sort?: Sort;
}
