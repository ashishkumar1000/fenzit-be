import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

/**
 * Leave-type catalog DTOs (23-13). The catalog is FIXED — types cannot be
 * created or deleted and names/codes/modes are inherent — so the PATCH
 * carries VALUES only. Unknown body keys (name/code/accrualMode) are
 * silently stripped by the global pipe (whitelist on, forbidNonWhitelisted
 * off): a rename attempt lands as the no-change answer and nothing
 * non-editable can persist.
 */
export class PatchLeaveTypeValuesDto {
  @ApiPropertyOptional({
    example: 1,
    description:
      'Days per month for a monthly type, or the annual grant. 0 = no value set yet (no credit accrues). Refused above 0 on Comp-Off (no accrual).',
  })
  @IsOptional()
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'accrualDays must be a number with at most 2 decimal places' },
  )
  @Min(0, { message: 'accrualDays must be 0 or more' })
  @Max(366, { message: 'accrualDays must be at most 366' })
  accrualDays?: number;

  @ApiPropertyOptional({
    example: true,
    description:
      'Carry the prior FY\u2019s unused balance into this FY. Monthly-accruing types only.',
  })
  @IsOptional()
  @IsBoolean({ message: 'carryForward must be true or false' })
  carryForward?: boolean;

  @ApiPropertyOptional({
    example: false,
    description:
      'Allow applies that exceed the balance. Monthly-accruing types only.',
  })
  @IsOptional()
  @IsBoolean({ message: 'allowOverBalance must be true or false' })
  allowOverBalance?: boolean;

  @ApiPropertyOptional({
    example: true,
    description:
      'true = paid (never LOP); false = unpaid (LOP in a payroll run)',
  })
  @IsOptional()
  @IsBoolean({ message: 'paid must be true or false' })
  paid?: boolean;

  @ApiPropertyOptional({
    example: true,
    description:
      'false hides the type from the employee catalog, blocks new applies and excludes it from payslip capture; consumed days still count.',
  })
  @IsOptional()
  @IsBoolean({ message: 'enabled must be true or false' })
  enabled?: boolean;
}

export class SetLeaveRequestTypeDto {
  @ApiPropertyOptional({
    example: '8f6ad6cd-0f2e-4d9a-9c6d-6f0d1a2b3c4d',
    nullable: true,
    description:
      'The catalog type for this request (must belong to the same company and be enabled), or null to clear the typing back to the untyped = paid default. Absent leaves it untouched.',
  })
  @IsOptional()
  // 'loose' — never '4'/'all' (Story 1 trap; see leave.dto.ts for the why)
  @IsUUID('loose', { message: 'leaveTypeId must be a UUID' })
  leaveTypeId?: string | null;
}

/** A catalog row as the API answers it (owner list, patch, employee list). */
export class LeaveTypeView {
  @ApiProperty({ example: '8f6ad6cd-0f2e-4d9a-9c6d-6f0d1a2b3c4d' })
  id: string;

  @ApiProperty({
    example: 'earned',
    nullable: true,
    description:
      'earned | sick | bereavement | comp_off — null marks a legacy remnant kept read-only',
  })
  code: string | null;

  @ApiProperty({ example: 'Earned Leave' })
  name: string;

  @ApiProperty({
    example: 'monthly',
    nullable: true,
    description: 'monthly | annual | none — how the type grants leave',
  })
  accrualMode: string | null;

  @ApiProperty({
    example: 1,
    description: 'Days per month (monthly) or the annual grant; 0 for none',
  })
  accrualDays: number;

  @ApiProperty({
    example: true,
    description:
      'The prior FY\u2019s unused balance carries into this FY (monthly types only)',
  })
  carryForward: boolean;

  @ApiProperty({
    example: false,
    description:
      'Applies that exceed the balance succeed instead of 422 (monthly types only)',
  })
  allowOverBalance: boolean;

  @ApiProperty({
    example: true,
    description:
      'true = paid (never LOP); false = unpaid (LOP in a payroll run)',
  })
  paid: boolean;

  @ApiProperty({
    example: true,
    description:
      'false = hidden from the employee catalog; applies and re-typing onto it are refused',
  })
  enabled: boolean;

  @ApiProperty({
    example: true,
    description:
      'false = a legacy remnant (code null) whose values cannot be edited',
  })
  configurable: boolean;

  @ApiProperty({ example: '2026-11-17T10:00:00.000Z' })
  createdAt: string;

  @ApiProperty({ example: '2026-11-17T10:00:00.000Z' })
  updatedAt: string;
}
