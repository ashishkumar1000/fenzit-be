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
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  LEAVE_MAX_SPAN_DAYS,
  LEAVE_PARTS,
  LEAVE_REASON_MAX,
} from '../leave.constants';

/**
 * Leave DTOs (17-1..17-4). Reasons are trimmed and must be non-empty after
 * trim (the whitespace-only hole the spec review closed); the DB CHECK is
 * the backstop. Half-day parts are single-date only — the service maps a
 * violation to LEAVE_INVALID_RANGE (the DTO cannot see the pairing).
 */
const trimString = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class ApplyLeaveDto {
  @ApiProperty({
    description: 'Range start, YYYY-MM-DD (tenant-local)',
    example: '2026-10-05',
  })
  @IsDateString(
    { strict: true },
    { message: 'startDate must be a YYYY-MM-DD date' },
  )
  startDate!: string;

  @ApiPropertyOptional({
    description: 'Range end; defaults to startDate for a single date',
  })
  @IsOptional()
  @IsDateString(
    { strict: true },
    { message: 'endDate must be a YYYY-MM-DD date' },
  )
  endDate?: string;

  @ApiPropertyOptional({
    description:
      'full_day (default) | first_half | second_half — halves are single-date only',
    default: 'full_day',
    enum: LEAVE_PARTS,
  })
  @IsOptional()
  @IsIn(LEAVE_PARTS)
  part: 'full_day' | 'first_half' | 'second_half' = 'full_day';

  @ApiProperty({
    description: 'Why the leave is needed (required, max 500 chars)',
    maxLength: LEAVE_REASON_MAX,
  })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty({ message: 'reason is required' })
  @MaxLength(LEAVE_REASON_MAX)
  reason!: string;
}

export class OnBehalfLeaveDto extends ApplyLeaveDto {
  @ApiProperty({ description: 'The employee the leave is created for' })
  @IsUUID('4', { message: 'employeeId must be a UUID v4' })
  employeeId!: string;
}

export class RejectLeaveDto {
  @ApiPropertyOptional({
    description: 'Optional rejection reason (FR-13: empty is valid)',
    maxLength: LEAVE_REASON_MAX,
  })
  @Transform(trimString)
  @IsOptional()
  @IsString()
  @MaxLength(LEAVE_REASON_MAX)
  reason?: string | null = null;
}

export class RevokeLeaveDto {
  @ApiProperty({
    description: 'Why the approved leave is being revoked (required, FR-14)',
    maxLength: LEAVE_REASON_MAX,
  })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty({ message: 'reason is required to revoke' })
  @MaxLength(LEAVE_REASON_MAX)
  reason!: string;
}

export class ListLeaveQueryDto {
  @ApiPropertyOptional({
    description: 'Filter by derived status (pending = the owner queue)',
    enum: ['pending', 'approved', 'revoked', 'cancelled', 'rejected'],
  })
  @IsOptional()
  @IsIn(['pending', 'approved', 'revoked', 'cancelled', 'rejected'])
  status?: 'pending' | 'approved' | 'revoked' | 'cancelled' | 'rejected';

  @ApiPropertyOptional({
    description: 'Filter to one employee (owner list only)',
  })
  @IsOptional()
  @IsUUID('4')
  employeeId?: string;

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
  limit?: number;
}

export class PreviewApplyQueryDto {
  @ApiProperty({ description: 'Range start, YYYY-MM-DD' })
  @IsDateString(
    { strict: true },
    { message: 'startDate must be a YYYY-MM-DD date' },
  )
  startDate!: string;

  @ApiPropertyOptional({ description: 'Range end; defaults to startDate' })
  @IsOptional()
  @IsDateString(
    { strict: true },
    { message: 'endDate must be a YYYY-MM-DD date' },
  )
  endDate?: string;

  @ApiPropertyOptional({
    description: 'full_day (default) | first_half | second_half',
    enum: LEAVE_PARTS,
  })
  @IsOptional()
  @IsIn(LEAVE_PARTS)
  part?: 'full_day' | 'first_half' | 'second_half';
}
