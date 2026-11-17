import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Validate,
} from 'class-validator';
import { PayrollCalendarDateConstraint } from './salary-structures.dto';

/**
 * Payroll calendar and state-rules DTOs (CAP-4, CAP-8). Calendar fields are
 * optional on a save (an absent field keeps the default for that date) but
 * have NO clear verb — a JSON null reaches the service and is refused 422,
 * the same tri-state idiom as the structures and leave-type DTOs.
 */
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export const DIVISOR_CONVENTIONS = [
  'calendar',
  'fixed-30',
  'fixed-26',
] as const;
export type DivisorConvention = (typeof DIVISOR_CONVENTIONS)[number];

export class PutPayrollCalendarDto {
  @ApiProperty({
    example: '2026-10-01',
    description:
      'Month-start effective dating: this revision governs the first run month whose first day is on/after this date. Saving the same date again REPLACES that dated revision.',
  })
  @Transform(trim)
  @IsString({ message: 'effectiveFrom must be text' })
  @IsNotEmpty({ message: 'effectiveFrom must not be empty' })
  @Validate(PayrollCalendarDateConstraint)
  effectiveFrom!: string;

  @ApiPropertyOptional({
    enum: DIVISOR_CONVENTIONS,
    description:
      'How a month is divided into pay days: calendar (real days), fixed-30 or fixed-26 (the default). Absent keeps the default.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString({ message: 'divisorConvention must be text' })
  divisorConvention?: string;

  @ApiPropertyOptional({
    example: 25,
    description:
      "Attendance cut-off day: dates after it in month M belong to M+1's run as prior-period days. 1-28 — February has fewer days than 29. Absent keeps the default.",
  })
  @IsOptional()
  @IsInt({ message: 'cutoffDay must be a whole number' })
  // Wire-shape sanity only — the DOMAIN range (1-28, with the February
  // reason) is the service's answer, so out-of-range values reach it and
  // get the plain-English refusal instead of generic validator text.
  @Max(9999, { message: 'cutoffDay must be between 1 and 28' })
  cutoffDay?: number;

  @ApiPropertyOptional({
    example: 1,
    description:
      'Pay date: the day of the following month wages are payable by. 1-7 — the Code on Wages requires payment before expiry of the 7th day. Absent keeps the default.',
  })
  @IsOptional()
  @IsInt({ message: 'payDate must be a whole number' })
  @Max(9999, { message: 'payDate must be between 1 and 7' })
  payDate?: number;
}

export class PutPayrollStateRulesDto {
  @ApiProperty({
    example: true,
    description:
      "Whether the company's state has notified its Code on Wages state rules. The product ships the central Form V template either way.",
  })
  @IsBoolean({ message: 'notified must be true or false' })
  notified!: boolean;
}

/** One dated calendar revision as the API answers it. */
export class PayrollCalendarView {
  @ApiProperty({ example: '2026-10-01' })
  effectiveFrom: string;

  @ApiProperty({ enum: DIVISOR_CONVENTIONS })
  divisorConvention: DivisorConvention;

  @ApiProperty({ example: 25 })
  cutoffDay: number;

  @ApiProperty({ example: 1 })
  payDate: number;

  @ApiProperty({ example: '2026-11-17T10:00:00.000Z' })
  createdAt: string;

  @ApiProperty({ example: '2026-11-17T10:00:00.000Z' })
  updatedAt: string;
}

/** What governs one run month, as the month-status API answers it. */
export class PayrollMonthStatusView {
  @ApiProperty({ example: '2026-10' })
  month: string;

  @ApiProperty({ enum: DIVISOR_CONVENTIONS })
  divisorConvention: DivisorConvention;

  @ApiProperty({ example: 25 })
  cutoffDay: number;

  @ApiProperty({ example: 1 })
  payDate: number;

  @ApiProperty({
    example: '2026-10-01',
    nullable: true,
    description:
      'The effectiveFrom of the dated revision governing this month — null when the defaults govern.',
  })
  effectiveFrom: string | null;

  @ApiProperty({
    example: false,
    description:
      'Always false until the payroll lock story ships; the contract field exists from day one.',
  })
  locked: boolean;

  @ApiProperty({
    example: '2026-09',
    nullable: true,
    description:
      'The earliest month any active employee joined — runs are accepted only for months on/after it. Null when nobody has a join date yet.',
  })
  firstPayrollMonth: string | null;

  @ApiProperty({
    example:
      'The first payroll month is 2026-09 — earlier months have no payroll history',
    nullable: true,
    description:
      'Why the month is not runnable (before the bound, or no bound yet). Null when runnable.',
  })
  notRunnableReason: string | null;
}

/** The state-rules flag as the API answers it. */
export class PayrollStateRulesView {
  @ApiProperty({ example: false })
  notified: boolean;

  @ApiProperty({ example: '2026-11-17T10:00:00.000Z' })
  updatedAt: string;
}
