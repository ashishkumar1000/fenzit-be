import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID, Validate } from 'class-validator';
import { AttendanceCalendarDateConstraint } from './attendance-date.validator';

/**
 * 19-3's monthly query DTOs. The wire dates are YYYY-MM-DD tenant-local
 * strings; the to ≤ tenant-today and span ≤ 31 pairings are service-level
 * 422s (`validateMonthlyRange` — the DTO cannot see the tenant clock).
 * The owner's optional officeId filters by today's covering assignment
 * office (D6) — malformed → 422 VALIDATION_ERROR here, unknown → 200 with
 * zero rows (a filter is not an entity fetch, D5's ruling).
 */
export class MonthlyQueryDto {
  @ApiProperty({ description: 'Range start, YYYY-MM-DD (tenant-local)' })
  @Validate(AttendanceCalendarDateConstraint)
  from!: string;

  @ApiProperty({
    description:
      'Range end, inclusive, ≤ 31 days after from, not after tenant-today',
  })
  @Validate(AttendanceCalendarDateConstraint)
  to!: string;

  @ApiPropertyOptional({
    description: 'Filter to this office id (today’s covering assignment office)',
  })
  @IsOptional()
  @IsUUID('all', { message: 'officeId must be a UUID' })
  officeId?: string;
}

export class MeMonthlyQueryDto {
  @ApiProperty({ description: 'Range start, YYYY-MM-DD (tenant-local)' })
  @Validate(AttendanceCalendarDateConstraint)
  from!: string;

  @ApiProperty({
    description:
      'Range end, inclusive, ≤ 31 days after from, not after tenant-today',
  })
  @Validate(AttendanceCalendarDateConstraint)
  to!: string;
}
