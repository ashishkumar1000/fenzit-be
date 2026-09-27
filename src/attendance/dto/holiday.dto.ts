import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength, Validate } from 'class-validator';
import { trim } from '../../common/utils/trim.transformer';
import { AttendanceCalendarDateConstraint } from './attendance-date.validator';

/**
 * Holiday name ceiling — mirrors the FE input (the DB column is unconstrained
 * TEXT; the ≤80 limit is the API contract, DTO-enforced).
 */
export const HOLIDAY_NAME_MAX = 80;

/** POST /attendance/holidays — add a tenant-wide holiday. */
export class CreateHolidayDto {
  @ApiProperty({
    description:
      'Holiday date (YYYY-MM-DD). Past dates allowed (statuses recompute on read); the date is immutable after creation.',
    example: '2026-10-02',
  })
  @Validate(AttendanceCalendarDateConstraint)
  date: string;

  @ApiProperty({
    description: 'Holiday name, trimmed.',
    example: 'Gandhi Jayanti',
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(HOLIDAY_NAME_MAX)
  name: string;
}

/**
 * PATCH /attendance/holidays/:id — name only. The date is deliberately NOT
 * accepted: impact and notifications differ per date, so a date change is
 * remove + add (scope decision 2026-09-27). A `date` key in the body is
 * rejected by whitelist forbidding (ValidationPipe) → 422.
 */
export class UpdateHolidayDto {
  @ApiProperty({ description: 'New holiday name, trimmed.', example: 'Diwali' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(HOLIDAY_NAME_MAX)
  name: string;
}

/** GET /attendance/holidays/impact?date= — AD-24 preview. */
export class HolidayDateQueryDto {
  @ApiProperty({
    description: 'Holiday date to preview impact for (YYYY-MM-DD).',
    example: '2026-10-02',
  })
  @Validate(AttendanceCalendarDateConstraint)
  date: string;
}
