import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  Validate,
} from 'class-validator';
import { OFFICE_HOURS_MAX, OFFICE_LATE_CUTOFF_MAX, OFFICE_LATE_CUTOFF_MIN, OFFICE_RADIUS_MAX, OFFICE_RADIUS_MIN, TIME_PATTERN } from './create-office.dto';
import {
  OfficeEndTimeAfterStartConstraint,
  OfficeHalfLessThanFullConstraint,
} from './office-rules.validators';

/**
 * One PATCH route (user decision 2026-09-26): every field optional, but the
 * service enforces two groups —
 *  - profile group (name/latitude/longitude/radiusM): NOT effective-dated,
 *    a guarded single-row UPDATE;
 *  - rules group (startTime/endTime/lateCutoffMinutes/fullDayHours/
 *    halfDayHours): effective-dated from tomorrow through
 *    attendance_update_office_rules — sent as a complete set of five.
 */
export class UpdateOfficeDto {
  @ApiPropertyOptional({ description: 'New office name (unique per tenant, case-insensitive); trimmed.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional({ description: 'New pin latitude (WGS-84).' })
  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude?: number;

  @ApiPropertyOptional({ description: 'New pin longitude (WGS-84).' })
  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude?: number;

  @ApiPropertyOptional({ description: 'New geofence radius in metres (50–1000).' })
  @IsOptional()
  @IsInt()
  @Min(OFFICE_RADIUS_MIN)
  @Max(OFFICE_RADIUS_MAX)
  radiusM?: number;

  @ApiPropertyOptional({ description: 'New office start time (HH:mm).' })
  @IsOptional()
  @Matches(TIME_PATTERN)
  startTime?: string;

  @ApiPropertyOptional({ description: 'New office end time (HH:mm); must be after start, same day.' })
  @IsOptional()
  @Matches(TIME_PATTERN)
  @Validate(OfficeEndTimeAfterStartConstraint)
  endTime?: string;

  @ApiPropertyOptional({ description: 'New late cut-off minutes (0–120).' })
  @IsOptional()
  @IsInt()
  @Min(OFFICE_LATE_CUTOFF_MIN)
  @Max(OFFICE_LATE_CUTOFF_MAX)
  lateCutoffMinutes?: number;

  @ApiPropertyOptional({ description: 'New full-day hours (> 0, up to 99.99).' })
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  @Max(OFFICE_HOURS_MAX)
  fullDayHours?: number;

  @ApiPropertyOptional({ description: 'New half-day hours (> 0, less than full-day hours).' })
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  @Max(OFFICE_HOURS_MAX)
  @Validate(OfficeHalfLessThanFullConstraint)
  halfDayHours?: number;
}