import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsArray, IsNotEmpty, IsString, Validate } from 'class-validator';
import {
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

/**
 * Per-employee salary structure DTOs (CAP-2). The envelope is validated here
 * (shape, real calendar date, lines is an array); the deep validation —
 * component ownership, amount/formula exclusivity, formula shape, cycles,
 * zero-operand division, negatives — is the service's, because every one of
 * those rules needs the company library and a plain-English message the
 * pipe cannot compose.
 */

/**
 * A YYYY-MM-DD that also denotes a REAL calendar date (the
 * attendance-date.validator idiom — a shape-only regex lets 2026-02-30
 * through, which would silently misplace a whole month's pay).
 */
@ValidatorConstraint({ name: 'isPayrollCalendarDate', async: false })
export class PayrollCalendarDateConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!m) return false;
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    const dt = new Date(Date.UTC(year, month - 1, day));
    // Round-trips only if the components survived JS Date's rollover
    // normalisation.
    return (
      dt.getUTCFullYear() === year &&
      dt.getUTCMonth() === month - 1 &&
      dt.getUTCDate() === day
    );
  }

  defaultMessage(): string {
    return 'effectiveFrom must be a real calendar date in YYYY-MM-DD format';
  }
}

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class PutSalaryStructureDto {
  @ApiProperty({
    example: '2026-09-01',
    description:
      'Month-start effective dating: this revision is first used by the first run month whose first day is on/after this date. Saving the same date again REPLACES that dated revision.',
  })
  @Transform(trim)
  @IsString({ message: 'effectiveFrom must be text' })
  @IsNotEmpty({ message: 'effectiveFrom must not be empty' })
  @Validate(PayrollCalendarDateConstraint)
  effectiveFrom!: string;

  @ApiProperty({
    example: [
      {
        componentId: '8f6ad6cd-0f2e-4d9a-9c6d-6f0d1a2b3c4d',
        amount: '20000.00',
      },
      {
        componentId: '0d9e4d0e-7a31-4c02-9b8e-5e2a1f6b7c8d',
        formula: {
          kind: 'percent-of',
          percent: 40,
          of: {
            kind: 'component',
            componentId: '8f6ad6cd-0f2e-4d9a-9c6d-6f0d1a2b3c4d',
          },
        },
      },
    ],
    description:
      'One line per component: an exact-decimal amount string ("20000.00") or a formula AST. Every component referenced must have a line; formulas may chain through formula lines, must not cycle, must not divide by a zero amount and must not compute a negative. The structure must include the company\'s basic component.',
  })
  @IsArray({ message: 'lines must be an array of component lines' })
  lines!: unknown[];
}

/** A stored line as the API answers it (computed amounts included). */
export class SalaryStructureLineView {
  @ApiProperty({ example: '8f6ad6cd-0f2e-4d9a-9c6d-6f0d1a2b3c4d' })
  componentId: string;

  @ApiProperty({
    example: 'Basic',
    description:
      'The component name as of this read — renames reach the next read.',
  })
  componentName: string;

  @ApiPropertyOptional({
    example: '20000.00',
    nullable: true,
    description: 'The fixed amount, when the line carries one.',
  })
  amount?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'The formula AST, when the line carries one.',
  })
  formula?: Record<string, unknown> | null;

  @ApiPropertyOptional({
    example: '20000.00',
    nullable: true,
    description:
      "The line's amount computed at read time (formula lines); omitted when the structure no longer evaluates.",
  })
  computedAmount?: string;
}

/** One dated revision as the API answers it. */
export class SalaryStructureView {
  @ApiProperty({ example: '2026-09-01' })
  effectiveFrom: string;

  @ApiProperty({ type: [SalaryStructureLineView] })
  lines: SalaryStructureLineView[];

  @ApiProperty({ example: '2026-11-17T10:00:00.000Z' })
  createdAt: string;

  @ApiProperty({ example: '2026-11-17T10:00:00.000Z' })
  updatedAt: string;
}
