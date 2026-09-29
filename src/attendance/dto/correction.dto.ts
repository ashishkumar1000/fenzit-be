import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  Validate,
} from 'class-validator';
import { AttendanceCalendarDateConstraint } from './attendance-date.validator';
import { STATUS_KEYS_READONLY } from '../day-status-response.model';

/**
 * Epic 18 DTOs (day-statuses reads 18-1, corrections 18-2). The wire dates
 * are YYYY-MM-DD tenant-local strings; the from ≤ to and span ≤ 62 pairing
 * is a service-level 422 (`validateDayStatusRange` — the DTO cannot see
 * cross-field rules). The note is trimmed here; the control-char and
 * length gates run in the service (D4 gate 1).
 */
const trimString = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const CORRECTION_STATUSES = ['present', 'half_day', 'absent'] as const;

export class PutCorrectionDto {
  @ApiProperty({
    description:
      'Status arm — present | half_day | absent. XOR with checkinAt/checkoutAt (mixing is a 422).',
    enum: CORRECTION_STATUSES,
  })
  @IsOptional()
  @IsIn(CORRECTION_STATUSES)
  status?: (typeof CORRECTION_STATUSES)[number];

  @ApiPropertyOptional({
    description:
      'Check-in instant, ISO-8601 with the tenant offset; anchors the work date exactly (gate 4). XOR with status.',
  })
  @IsOptional()
  @IsDateString({ strict: true }, { message: 'checkinAt must be an ISO-8601 instant' })
  checkinAt?: string;

  @ApiPropertyOptional({
    description:
      'Check-out instant, ISO-8601; falls on the work date (or the next day). Optional with a corrected check-in.',
  })
  @IsOptional()
  @IsDateString({ strict: true }, { message: 'checkoutAt must be an ISO-8601 instant' })
  checkoutAt?: string;

  @ApiProperty({
    description: 'Why the value changed (required, 1-500 after trim)',
    maxLength: 500,
  })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty({ message: 'note is required' })
  note!: string;
}

export class AcknowledgeDto {
  @ApiProperty({ description: 'The employee whose mocked attempts are acknowledged' })
  @IsUUID('4', { message: 'employeeId must be a UUID v4' })
  employeeId!: string;

  @ApiProperty({ description: 'The attempted_at (tenant-local) date to acknowledge' })
  @Validate(AttendanceCalendarDateConstraint)
  workDate!: string;
}

export class DayStatusesQueryDto {
  @ApiProperty({ description: 'The employee to read (owner route, 404-no-leak)' })
  @IsUUID('4', { message: 'employeeId must be a UUID v4' })
  employeeId!: string;

  @ApiProperty({ description: 'Range start, YYYY-MM-DD (tenant-local)' })
  @Validate(AttendanceCalendarDateConstraint)
  from!: string;

  @ApiProperty({ description: 'Range end, inclusive, ≤ 62 days after from' })
  @Validate(AttendanceCalendarDateConstraint)
  to!: string;
}

export class MeDayStatusesQueryDto {
  @ApiProperty({ description: 'Range start, YYYY-MM-DD (tenant-local)' })
  @Validate(AttendanceCalendarDateConstraint)
  from!: string;

  @ApiProperty({ description: 'Range end, inclusive, ≤ 62 days after from' })
  @Validate(AttendanceCalendarDateConstraint)
  to!: string;
}

export class ListCorrectionsQueryDto {
  @ApiPropertyOptional({ description: 'Filter to one work date, YYYY-MM-DD' })
  @IsOptional()
  @Validate(AttendanceCalendarDateConstraint)
  workDate?: string;

  @ApiPropertyOptional({ description: 'Opaque cursor from the previous page' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({
    description: 'Page size (1-50, default 20)',
    minimum: 1,
    maximum: 50,
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? Number(value) : value))
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

// The engine's full status vocabulary re-enters the swagger for the
// latestCorrection old/new values and the day-status rows.
export { STATUS_KEYS_READONLY as EPIC_18_STATUS_KEYS };
