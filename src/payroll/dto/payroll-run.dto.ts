import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsString,
  Matches,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class PostPayrollRunDto {
  @ApiProperty({
    example: '2026-10',
    description:
      "The month to run, YYYY-MM. Accepted only for months on/after the company's first payroll month, not in the future, and on/after the month's cut-off day (tenant time) — each refusal carries its plain-English reason.",
  })
  @Transform(trim)
  @IsString({ message: 'month must be text' })
  @IsNotEmpty({ message: 'month must not be empty' })
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: 'month must be a real month written as YYYY-MM',
  })
  month!: string;
}

export class PayrollRunView {
  @ApiProperty({ example: '9f6ad6cd-0f2e-4d9a-9c6d-6f0d1a2b3c4d' })
  id: string;

  @ApiProperty({ example: '2026-10' })
  month: string;

  @ApiProperty({
    enum: ['queued', 'running', 'completed', 'failed'],
    description: 'failed is terminal and retryable — re-POST the month',
  })
  status: string;

  @ApiProperty({
    nullable: true,
    description: 'Present once completed: skips, warnings, recovery balances.',
  })
  summary: Record<string, unknown> | null;

  @ApiProperty({
    nullable: true,
    description: 'Why the run failed (plain English, never DB text).',
  })
  errorMessage: string | null;

  @ApiProperty({ nullable: true })
  startedAt: string | null;

  @ApiProperty({ nullable: true })
  finishedAt: string | null;
}

export class PutPayrollRunOverrideDto {
  @ApiProperty({
    example: '2026-10',
    description:
      'The salary period the override applies to — one employee, one period.',
  })
  @Transform(trim)
  @IsString({ message: 'month must be text' })
  @IsNotEmpty({ message: 'month must not be empty' })
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: 'month must be a real month written as YYYY-MM',
  })
  month!: string;

  @ApiProperty({
    enum: ['pf_employee', 'tds'],
    description: 'Which computed amount the override replaces.',
  })
  @Transform(trim)
  @IsIn(['pf_employee', 'tds'], {
    message: 'field must be pf_employee or tds',
  })
  field!: string;

  @ApiProperty({
    example: '12000.00',
    description:
      'The amount to pay instead, as money text (digits, at most 2 decimals).',
  })
  @Transform(trim)
  @IsString({ message: 'amount must be text' })
  @IsNotEmpty({ message: 'amount must not be empty' })
  @Matches(/^\d{1,12}(\.\d{1,2})?$/, {
    message: 'amount must be money text — digits with at most 2 decimals',
  })
  amount!: string;

  @ApiProperty({
    example: true,
    description:
      'The employer-liability acknowledgment — the run pays the overridden amount and the employer carries the statutory exposure. Must be true.',
  })
  @IsBoolean({ message: 'acknowledgedLiability must be true' })
  acknowledgedLiability!: boolean;
}

export class PayrollRunOverrideView {
  @ApiProperty({ example: '2026-10' })
  month: string;

  @ApiProperty({ enum: ['pf_employee', 'tds'] })
  field: string;

  @ApiProperty({ example: '12000.00' })
  amount: string;

  @ApiProperty({ example: '2026-11-18T10:00:00.000Z' })
  updatedAt: string;
}
