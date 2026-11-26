import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { trim, trimArray } from '../../common/utils/trim.transformer';
import { AttendanceCalendarDateConstraint } from './attendance-date.validator';
import { HOLIDAY_SCOPES } from '../../common/day-status/holiday-scope';

/**
 * Holiday name ceiling — mirrors the FE input (the DB column is unconstrained
 * TEXT; the ≤80 limit is the API contract, DTO-enforced).
 */
export const HOLIDAY_NAME_MAX = 80;

/** Holiday description ceiling — the schedule page's one-liner. */
export const HOLIDAY_DESCRIPTION_MAX = 280;

/**
 * Cross-field scope/office rule: `scope: 'offices'` must carry a non-empty
 * officeIds list; `'all'` (the default) must carry none that matters. A
 * class-level constraint so BOTH create and update share it (422 via the
 * global ValidationPipe, like every field failure).
 */
@ValidatorConstraint({ name: 'holidayOfficeScope', async: false })
export class HolidayOfficeScopeConstraint implements ValidatorConstraintInterface {
  validate(_: unknown, args?: { object: HolidayScopeFields }): boolean {
    const dto = args?.object;
    if (!dto) return false;
    const scope = dto.scope ?? 'all';
    if (!HOLIDAY_SCOPES.includes(scope as never)) return false;
    if (scope === 'offices') {
      return Array.isArray(dto.officeIds) && dto.officeIds.length > 0;
    }
    return true;
  }

  defaultMessage(): string {
    return "scope 'offices' requires a non-empty officeIds list";
  }
}

interface HolidayScopeFields {
  scope?: string;
  officeIds?: string[];
}

/** POST /attendance/holidays — add a holiday (all offices or named offices). */
export class CreateHolidayDto {
  @ApiProperty({
    description: 'Holiday date (YYYY-MM-DD). Past dates allowed (statuses recompute on read); editable via PATCH.',
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

  @ApiProperty({
    description: 'Optional one-line description (the schedule page renders it).',
    example: 'National holiday — birthday of the Father of the Nation',
    required: false,
  })
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(HOLIDAY_DESCRIPTION_MAX)
  description?: string | null;

  @ApiProperty({
    description: "'all' (default — every office) or 'offices' (only officeIds).",
    example: 'all',
    required: false,
  })
  @IsOptional()
  @IsIn(HOLIDAY_SCOPES)
  scope?: string;

  @ApiProperty({
    description: "Office ids closed by this holiday — required when scope is 'offices'.",
    type: [String],
    required: false,
  })
  @Transform(trimArray)
  @Type(() => String)
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  officeIds?: string[];

  @Validate(HolidayOfficeScopeConstraint)
  scopeCheck?: string;
}

/**
 * PATCH /attendance/holidays/:id — every field is editable, including the
 * date (console redesign 2026-11-26 reverses the old remove+add scope
 * decision; a date collision stays a 409). Omitted fields keep their
 * values; `description: null` clears it.
 */
export class UpdateHolidayDto {
  @ApiProperty({
    description: 'New holiday name, trimmed.',
    example: 'Diwali (Deepavali)',
    required: false,
  })
  @Transform(trim)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(HOLIDAY_NAME_MAX)
  name?: string;

  @ApiProperty({
    description: 'New description; null clears it.',
    required: false,
  })
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(HOLIDAY_DESCRIPTION_MAX)
  description?: string | null;

  @ApiProperty({
    description: 'New holiday date (YYYY-MM-DD); 409 when the target date is taken.',
    example: '2026-11-08',
    required: false,
  })
  @IsOptional()
  @Validate(AttendanceCalendarDateConstraint)
  date?: string;

  @ApiProperty({
    description: "'all' or 'offices'.",
    required: false,
  })
  @IsOptional()
  @IsIn(HOLIDAY_SCOPES)
  scope?: string;

  @ApiProperty({
    description: "Office ids closed by this holiday — required when scope is 'offices'.",
    type: [String],
    required: false,
  })
  @Transform(trimArray)
  @Type(() => String)
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  officeIds?: string[];

  @Validate(HolidayOfficeScopeConstraint)
  scopeCheck?: string;
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

/** GET /attendance/holidays/overview?year= — the console's year view. */
export class HolidayOverviewQueryDto {
  @ApiProperty({
    description: 'Four-digit calendar year to list holidays for.',
    example: '2026',
  })
  @Matches(/^\d{4}$/)
  year: string;
}
