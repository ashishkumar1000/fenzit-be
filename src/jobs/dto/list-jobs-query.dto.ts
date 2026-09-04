import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { JobStatus } from '../enums/job-status.enum';
import { JobListScope } from '../enums/job-list-scope.enum';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

// Fastify's default parser delivers a repeated query key as a string (one
// occurrence) or an array (2+). Normalize to `string[] | undefined` so the
// service always sees an
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

// Cross-field rule: the timeline scopes other than `today` key on the full
// timeline (tomorrow-onward / pre-today / all-time), so re-anchoring them to a
// calendar day is meaningless — reject scope+date combinations with a 422 via
// the global ValidationPipe. scope='today' + date stays legal: today IS the
// default scope and `date` re-anchors its IST day window.
@ValidatorConstraint({ name: 'scopeDateExclusivity', async: false })
class ScopeDateExclusivityConstraint implements ValidatorConstraintInterface {
  validate(scope: unknown, args: ValidationArguments): boolean {
    if (scope === undefined || scope === null) return true;
    const date = (args.object as ListJobsQueryDto).date;
    return scope === JobListScope.TODAY || date === undefined;
  }

  defaultMessage(): string {
    return 'date cannot be combined with scope (only scope=today accepts a date)';
  }
}

export class ListJobsQueryDto {
  @ApiPropertyOptional({
    enum: JobListScope,
    description:
      'Timeline scope: today (default, IST day window), upcoming (tomorrow onward, scheduled), overdue (pre-today, scheduled/in_progress), history (completed/cancelled). Mutually exclusive with date except today.',
  })
  @IsOptional()
  @Transform(trim)
  @IsEnum(JobListScope)
  @Validate(ScopeDateExclusivityConstraint)
  scope?: JobListScope;
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

  @ApiPropertyOptional({
    example: 20,
    description: 'Max jobs to return (1-50). Defaults to 50 if omitted.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
