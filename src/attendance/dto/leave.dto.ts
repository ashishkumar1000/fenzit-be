import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
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
  Validate,
} from 'class-validator';
import { AttendanceCalendarDateConstraint } from './attendance-date.validator';
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

  @ApiPropertyOptional({
    description:
      'A type from the company leave catalog (CAP-12); must belong to the same company or the apply answers 404. Absent or null keeps the request untyped, which reads as paid.',
    nullable: true,
  })
  @IsOptional()
  // 'loose' = shape-only hex-dash. Story 1 trap, re-found 2026-11-20: never
  // '4' AND never bare 'all' — class-validator's 'all' checks version 1-7 +
  // 89AB variant and rejects 83/173 REAL user ids (hash-style seeded ids,
  // e.g. Ajay EMP-080). 'loose' = parity with NestJS ParseUUIDPipe's 'all'.
  @IsUUID('loose', { message: 'leaveTypeId must be a UUID' })
  leaveTypeId?: string | null;
}

export class OnBehalfLeaveDto extends ApplyLeaveDto {
  @ApiProperty({ description: 'The employee the leave is created for' })
  // 'loose' — never '4', never bare 'all' (83/173 real user ids fail 'all';
  // see the leaveTypeId note above).
  @IsUUID('loose')
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
  @IsUUID('loose') // never '4'/'all' — 83/173 real user ids fail 'all' (see OnBehalfLeaveDto)
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

  @ApiPropertyOptional({
    description:
      "Owner list only: window start, YYYY-MM-DD (tenant-local). Requests OVERLAPPING the window match — end_date >= from AND start_date <= to, both edges inclusive. from and to are sent together, from <= to (422 otherwise) — the calendar's month read.",
    example: '2026-11-01',
  })
  @IsOptional()
  @Validate(AttendanceCalendarDateConstraint)
  from?: string;

  @ApiPropertyOptional({
    description:
      'Owner list only: window end, YYYY-MM-DD (tenant-local); sent together with from, from <= to (422 otherwise).',
    example: '2026-11-30',
  })
  @IsOptional()
  @Validate(AttendanceCalendarDateConstraint)
  to?: string;
}

/**
 * The employee's own list binds a narrowed copy of the owner query: the 27-1
 * window is an owner-list capability (listMine drops it), so this endpoint
 * neither validates nor advertises from/to — a client sending them there
 * gets the same silent-strip every unknown key gets.
 */
export class ListMeLeaveQueryDto extends OmitType(ListLeaveQueryDto, [
  'from',
  'to',
] as const) {}

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

  @ApiPropertyOptional({
    description:
      'A catalog type to validate the spend against — the preview then runs the apply-time balance check (23-14: the form catches an insufficient balance at pick time, not as a submit 422)',
    nullable: true,
  })
  @IsOptional()
  // 'loose' — never '4'/'all' (see ApplyLeaveDto.leaveTypeId).
  @IsUUID('loose', { message: 'leaveTypeId must be a UUID' })
  leaveTypeId?: string | null;
}

/** The owner's on-behalf apply preview (23-14): the FR-12 validation for a
 *  PROPOSED spend on a chosen employee — the same checks the on-behalf
 *  POST runs (persist:false), so the apply-on-behalf form catches a
 *  rejection (insufficient balance, locked month, overlap) at pick time
 *  instead of at submit. */
export class OnBehalfPreviewQueryDto extends PreviewApplyQueryDto {
  @ApiProperty({ description: 'The employee the leave would be created for' })
  // 'loose' — never '4'/'all' (see OnBehalfLeaveDto.employeeId).
  @IsUUID('loose')
  employeeId!: string;
}
