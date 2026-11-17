import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

/**
 * Leave-type catalog DTOs (CAP-12). Name and paid have NO clear verb — a
 * catalog entry is renamed or re-marked, never partially emptied — so a JSON
 * null reaches the service, which answers 422 (IsOptional deliberately lets
 * it past the pipe). Tri-state handling mirrors the employment DTOs: absent
 * = untouched, null = clear where a clear exists, value = set.
 */
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateLeaveTypeDto {
  @ApiProperty({
    example: 'Casual Leave',
    description:
      'Catalog name, unique inside the company. Without an explicit paid flag the marking defaults by keyword: casual/sick/earned → paid, unpaid/LOP → unpaid, anything else → paid.',
  })
  @Transform(trim)
  @IsString({ message: 'name must be text' })
  @IsNotEmpty({ message: 'name must not be empty or whitespace' })
  @MaxLength(60, { message: 'name must be at most 60 characters' })
  name!: string;

  @ApiPropertyOptional({
    example: false,
    nullable: true,
    description:
      'Paid marking. Absent (or null) applies the keyword default; true = never LOP, false = LOP in a payroll run.',
  })
  @IsOptional()
  @IsBoolean({ message: 'paid must be true or false' })
  paid?: boolean | null;
}

export class UpdateLeaveTypeDto {
  @ApiPropertyOptional({
    example: 'Casual Leave',
    nullable: true,
    description:
      'New catalog name (unique inside the company). null is refused — rename, never clear.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString({ message: 'name must be text' })
  @MaxLength(60, { message: 'name must be at most 60 characters' })
  name?: string | null;

  @ApiPropertyOptional({
    example: false,
    nullable: true,
    description: 'New paid marking. null is refused — flip it, never clear it.',
  })
  @IsOptional()
  @IsBoolean({ message: 'paid must be true or false' })
  paid?: boolean | null;
}

export class SetLeaveRequestTypeDto {
  @ApiPropertyOptional({
    example: '8f6ad6cd-0f2e-4d9a-9c6d-6f0d1a2b3c4d',
    nullable: true,
    description:
      'The catalog type for this request (must belong to the same company), or null to clear the typing back to the untyped = paid default. Absent leaves it untouched.',
  })
  @IsOptional()
  @IsUUID('4', { message: 'leaveTypeId must be a UUID' })
  leaveTypeId?: string | null;
}

/** A catalog row as the API answers it (list/create/update). */
export class LeaveTypeView {
  @ApiProperty({ example: '8f6ad6cd-0f2e-4d9a-9c6d-6f0d1a2b3c4d' })
  id: string;

  @ApiProperty({ example: 'Casual Leave' })
  name: string;

  @ApiProperty({
    example: true,
    description:
      'true = paid (never LOP); false = unpaid (LOP in a payroll run)',
  })
  paid: boolean;

  @ApiProperty({ example: '2026-11-17T10:00:00.000Z' })
  createdAt: string;

  @ApiProperty({ example: '2026-11-17T10:00:00.000Z' })
  updatedAt: string;
}

/** A create answer; `appliedDefault` appears only when the keyword default was applied. */
export class LeaveTypeCreatedView extends LeaveTypeView {
  @ApiPropertyOptional({
    enum: ['paid', 'unpaid'],
    nullable: true,
    description:
      'The marking the company default chose for this name — present only when the body carried no explicit paid flag.',
  })
  appliedDefault?: 'paid' | 'unpaid';
}
