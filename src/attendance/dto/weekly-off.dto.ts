import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayUnique, IsArray, IsIn, IsOptional, Validate } from 'class-validator';
import { AttendanceCalendarDateConstraint } from './attendance-date.validator';

/**
 * ISO weekday numbers, 1 = Monday .. 7 = Sunday — the DB CHECK's vocabulary
 * (20260927000001). These DTO mirrors give a pre-DB 422; the CHECKs remain
 * the authority (NFR-4).
 *
 * FR-18's zero-working-days rule is NOT capped here: a size cap would surface
 * a 7-day selection as a generic VALIDATION_ERROR, but the I/O matrix pins
 * ATTENDANCE_NO_WORKING_DAYS — the service's pre-RPC guard
 * (assertWorkingDayRemains) owns that 422, the DB CHECK stays the backstop.
 * An EMPTY array is legal — for the default it means "clear: all 7 days
 * working" (no covering row); for an override it means "this employee works
 * all 7 days" (the override replaces the default, AD-22).
 */
export const WEEKLY_OFF_DAYS = [1, 2, 3, 4, 5, 6, 7] as const;

/** Shared `days` array validation — element range and uniqueness, empty allowed. */
abstract class WeeklyOffDaysDto {
  @ApiProperty({
    description:
      'Weekly-off days, ISO weekday numbers (1=Mon .. 7=Sun). Empty array = works all 7 days.',
    example: [6, 7],
    type: [Number],
  })
  @IsArray()
  @IsIn(WEEKLY_OFF_DAYS, { each: true })
  @ArrayUnique()
  days: number[];

  @ApiPropertyOptional({
    description:
      'Effective date (YYYY-MM-DD), default today. Dates before today are clamped to today by the RPC (AD-8).',
    example: '2026-10-05',
  })
  @IsOptional()
  @Validate(AttendanceCalendarDateConstraint)
  effectiveFrom?: string;
}

/** PUT /attendance/weekly-offs — set (or clear) the tenant default. */
export class SetWeeklyOffDefaultDto extends WeeklyOffDaysDto {}

/**
 * PUT /attendance/weekly-offs/overrides/:employeeId — set (or clear) one
 * employee's override. The override replaces the tenant default while its
 * range covers the date; removal is the DELETE route, a distinct operation.
 */
export class SetWeeklyOffOverrideDto extends WeeklyOffDaysDto {}

/** DELETE /attendance/weekly-offs/overrides/:employeeId?effectiveFrom= */
export class RemoveOverrideQueryDto {
  @ApiPropertyOptional({
    description: 'Removal effective from (YYYY-MM-DD), default today.',
    example: '2026-10-05',
  })
  @IsOptional()
  @Validate(AttendanceCalendarDateConstraint)
  effectiveFrom?: string;
}
