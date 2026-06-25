import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { JobStatus } from '../enums/job-status.enum';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

// Fastify/qs delivers a repeated query key as a string (one occurrence) or an
// array (2+). Normalize to `string[] | undefined` so the service always sees an
// array. The @IsEnum(..., { each: true }) then rejects any invalid member → 422.
const toArray = ({ value }: { value: unknown }) =>
  value === undefined ? undefined : Array.isArray(value) ? value : [value];

// A YYYY-MM-DD that also denotes a REAL calendar date. A shape-only regex lets
// impossible values through (2026-13-01, 2026-00-00, 2026-02-30); those reach
// the service as `Invalid Date` and either crash `range.start.toISOString()`
// with a 500 (out-of-range month) or silently roll over to the wrong day
// (2026-02-30 → Mar 2). Rejecting them here yields a 422 via the global
// ValidationPipe instead (AC#9).
@ValidatorConstraint({ name: 'isCalendarDate', async: false })
class IsCalendarDateConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!m) return false;
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    const dt = new Date(Date.UTC(year, month - 1, day));
    // Round-trips only if the components survived JS Date's rollover normalization.
    return (
      dt.getUTCFullYear() === year &&
      dt.getUTCMonth() === month - 1 &&
      dt.getUTCDate() === day
    );
  }

  defaultMessage(): string {
    return 'date must be a valid calendar date in YYYY-MM-DD format';
  }
}

export class ListJobsQueryDto {
  @ApiPropertyOptional({
    example: '2026-06-20',
    description:
      'Calendar date (YYYY-MM-DD) whose IST day window to list. Defaults to today in IST.',
  })
  @IsOptional()
  @Transform(trim)
  @Validate(IsCalendarDateConstraint)
  date?: string;

  @ApiPropertyOptional({
    enum: JobStatus,
    isArray: true,
    description: 'Repeatable. Filter to jobs with any of these statuses.',
  })
  @Transform(toArray)
  @IsOptional()
  @IsArray()
  @IsEnum(JobStatus, { each: true })
  status?: JobStatus[];

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Owner only — filter to one technician. Ignored for technician callers.',
  })
  @IsOptional()
  @IsUUID() // default version 'all' — never '4' (Story 1 IsUUID('4') trap)
  technicianId?: string;

  @ApiPropertyOptional({
    description: 'Opaque pagination cursor from a previous response',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(512)
  cursor?: string;
}
