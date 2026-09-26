import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  Validate,
} from 'class-validator';
import {
  OfficeEndTimeAfterStartConstraint,
  OfficeHalfLessThanFullConstraint,
} from './office-rules.validators';

/**
 * DB CHECK constraints are the final authority on these ranges (NFR-4);
 * these mirrors exist so the ValidationPipe rejects out-of-range payloads
 * with a 422 before the DB is ever touched (AD-7's "DTO allowlist mirrors
 * it" pattern). Changed by migration only.
 */
export const OFFICE_RADIUS_MIN = 50;
export const OFFICE_RADIUS_MAX = 1000;
export const OFFICE_RADIUS_DEFAULT = 100;
export const OFFICE_LATE_CUTOFF_MIN = 0;
export const OFFICE_LATE_CUTOFF_MAX = 120;
export const OFFICE_LATE_CUTOFF_DEFAULT = 15;
export const OFFICE_FULL_DAY_DEFAULT = 8;
export const OFFICE_HALF_DAY_DEFAULT = 4;
/** Matches the numeric(4,2) columns — the mirror for precision overflow. */
export const OFFICE_HOURS_MAX = 99.99;

/** "HH:mm" 24-hour wall-clock — the PRD stores Start/End as TIME. */
export const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export class CreateOfficeDto {
  @ApiProperty({ description: 'Office name, unique per tenant (case-insensitive); trimmed.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name: string;

  @ApiProperty({ description: 'Pin latitude (WGS-84).', example: 19.076 })
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude: number;

  @ApiProperty({ description: 'Pin longitude (WGS-84).', example: 72.8777 })
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude: number;

  @ApiPropertyOptional({
    description: 'Geofence radius in metres.',
    default: OFFICE_RADIUS_DEFAULT,
  })
  @IsInt()
  @Min(OFFICE_RADIUS_MIN)
  @Max(OFFICE_RADIUS_MAX)
  radiusM: number = OFFICE_RADIUS_DEFAULT;

  @ApiProperty({ description: 'Office start time (HH:mm).', example: '10:00' })
  @Matches(TIME_PATTERN)
  startTime: string;

  @ApiProperty({ description: 'Office end time (HH:mm); must be after start, same day.', example: '18:00' })
  @Matches(TIME_PATTERN)
  @Validate(OfficeEndTimeAfterStartConstraint)
  endTime: string;

  @ApiPropertyOptional({
    description: 'Late cut-off minutes after the start time.',
    default: OFFICE_LATE_CUTOFF_DEFAULT,
  })
  @IsInt()
  @Min(OFFICE_LATE_CUTOFF_MIN)
  @Max(OFFICE_LATE_CUTOFF_MAX)
  lateCutoffMinutes: number = OFFICE_LATE_CUTOFF_DEFAULT;

  @ApiPropertyOptional({
    description: 'Full-day hours (> 0).',
    default: OFFICE_FULL_DAY_DEFAULT,
  })
  @IsNumber()
  @Min(0.01)
  @Max(OFFICE_HOURS_MAX)
  fullDayHours: number = OFFICE_FULL_DAY_DEFAULT;

  @ApiPropertyOptional({
    description: 'Half-day hours (> 0, less than full-day hours).',
    default: OFFICE_HALF_DAY_DEFAULT,
  })
  @IsNumber()
  @Min(0.01)
  @Max(OFFICE_HOURS_MAX)
  @Validate(OfficeHalfLessThanFullConstraint)
  halfDayHours: number = OFFICE_HALF_DAY_DEFAULT;
}