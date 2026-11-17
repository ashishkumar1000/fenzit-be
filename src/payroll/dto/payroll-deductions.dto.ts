import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Validate,
} from 'class-validator';
import { PayrollCalendarDateConstraint } from './salary-structures.dto';

/**
 * Deduction-head, PF-config and PF-exclusion DTOs (CAP-6). The same tri-state
 * idiom as the calendar: an absent field keeps the default for that save, an
 * explicit null is refused (no clear verb).
 */
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export const HEAD_KINDS = ['flat', 'percent'] as const;
export type HeadKind = (typeof HEAD_KINDS)[number];
export const HEAD_BASES = ['basic', 'gross'] as const;
export type HeadBasis = (typeof HEAD_BASES)[number];

/** Flat money ("200.00") — up to 12 integer digits, 1-2 decimals, positive. */
export const FLAT_AMOUNT_SHAPE = /^\d{1,12}(\.\d{1,2})?$/;
/** A percentage ("2", "2.5", "0.25") — 0 < p ≤ 100, at most 2 decimals. */
export const PERCENT_SHAPE = /^(100(\.00?)?|\d{1,2}(\.\d{1,2})?)$/;

export class PutDeductionHeadDto {
  @ApiProperty({
    example: 'Professional Tax',
    description:
      "The head's name — unique per company per effective date; saving the same name and date again REPLACES that dated revision.",
  })
  @Transform(trim)
  @IsString({ message: 'name must be text' })
  @IsNotEmpty({ message: 'name must not be empty' })
  @MaxLength(60, { message: 'name must be at most 60 characters' })
  name!: string;

  @ApiProperty({
    enum: HEAD_KINDS,
    description:
      'flat = a fixed monthly amount; percent = a percentage of the chosen earned basis',
  })
  @Transform(trim)
  @IsIn(HEAD_KINDS, {
    message: 'kind must be flat or percent',
  })
  kind!: HeadKind;

  @ApiProperty({
    example: '200.00',
    description:
      "flat: the monthly amount as money text ('200.00'); percent: the percentage (0 < p ≤ 100, at most 2 decimals, '2.00' or '2.5').",
  })
  @Transform(trim)
  @IsString({ message: 'amount must be text' })
  @IsNotEmpty({ message: 'amount must not be empty' })
  amount!: string;

  @ApiPropertyOptional({
    enum: HEAD_BASES,
    description:
      'percent heads only — which earned basis the percentage applies to: the earned basic or the post-LOP gross. A flat head must NOT carry a basis.',
  })
  @IsOptional()
  @Transform(trim)
  @IsIn(HEAD_BASES, {
    message: 'basis must be basic or gross',
  })
  basis?: HeadBasis;

  @ApiProperty({
    example: '2026-09-01',
    description:
      'Month-start effective dating: this revision governs the first run month whose first day is on/after this date.',
  })
  @Transform(trim)
  @IsString({ message: 'effectiveFrom must be text' })
  @IsNotEmpty({ message: 'effectiveFrom must not be empty' })
  @Validate(PayrollCalendarDateConstraint)
  effectiveFrom!: string;
}

export class PutHeadDeactivateDto {
  @ApiProperty({
    example: true,
    description:
      'Only true is accepted — deactivation has no undo verb; re-saving the head with a new dated revision is the way back.',
  })
  @IsBoolean({ message: 'confirm must be true' })
  confirm!: boolean;
}

/** One dated deduction-head revision as the API answers it. */
export class DeductionHeadView {
  @ApiProperty({ example: '9f6ad6cd-0f2e-4d9a-9c6d-6f0d1a2b3c4d' })
  id: string;

  @ApiProperty({ example: 'Professional Tax' })
  name: string;

  @ApiProperty({ enum: HEAD_KINDS })
  kind: HeadKind;

  @ApiProperty({ example: '200.00' })
  amount: string;

  @ApiProperty({ enum: HEAD_BASES, nullable: true })
  basis: HeadBasis | null;

  @ApiProperty({ example: '2026-09-01' })
  effectiveFrom: string;

  @ApiProperty({ example: true })
  active: boolean;

  @ApiProperty({ example: '2026-11-17T10:00:00.000Z' })
  updatedAt: string;
}

export class PutPayrollPfConfigDto {
  @ApiProperty({
    example: '2026-09-01',
    description:
      'Month-start effective dating: the switch governs the first run month whose first day is on/after this date. Saving the same date again REPLACES that dated revision.',
  })
  @Transform(trim)
  @IsString({ message: 'effectiveFrom must be text' })
  @IsNotEmpty({ message: 'effectiveFrom must not be empty' })
  @Validate(PayrollCalendarDateConstraint)
  effectiveFrom!: string;

  @ApiProperty({
    example: true,
    description:
      'Whether the company covers its employees under EPF from this date. Employees already carrying a UAN or PF account number are covered regardless of this switch — and regardless of when it was switched on.',
  })
  @IsBoolean({ message: 'covered must be true or false' })
  covered!: boolean;
}

/** One dated PF-covered revision as the API answers it. */
export class PayrollPfConfigView {
  @ApiProperty({ example: '2026-09-01' })
  effectiveFrom: string;

  @ApiProperty({ example: true })
  covered: boolean;

  @ApiProperty({ example: '2026-11-17T10:00:00.000Z' })
  updatedAt: string;
}

export class PutPayrollPfExclusionDto {
  @ApiProperty({
    example: true,
    description:
      'Exclude this employee from PF. Refused while the employee carries a UAN or PF account number — anyone ever an EPF member is covered at any wage, whatever the switch says.',
  })
  @IsBoolean({ message: 'excluded must be true or false' })
  excluded!: boolean;
}

export class PayrollPfExclusionView {
  @ApiProperty({
    example: false,
    description:
      'False when no exclusion row exists — the enrollment default is covered.',
  })
  excluded: boolean;

  @ApiProperty({
    example: '2026-11-17T10:00:00.000Z',
    description:
      'The 1970 epoch is the sentinel for "no exclusion row exists".',
  })
  updatedAt: string;
}

/** The FY 2026-27 statutory TDS constants, read-only. */
export class TdsConfigView {
  @ApiProperty({ example: 'FY 2026-27' })
  taxYear: string;

  @ApiProperty({ example: 'new' })
  regime: string;

  @ApiProperty({ example: '75000.00' })
  standardDeduction: string;

  @ApiProperty({
    description:
      'The slab rows; upto null is the top slab. ratePercent is the slab rate as a whole/fractional percent.',
  })
  slabs: Array<{ upto: number | null; ratePercent: number }>;

  @ApiProperty({ description: 'The resident-only s.157 rebate.' })
  rebate: {
    section: string;
    threshold: number;
    residentOnly: boolean;
    description: string;
  };

  @ApiProperty({ example: 4 })
  cessRatePercent: number;
}
