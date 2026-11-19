import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export const OFF_CYCLE_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export class CreateOffCycleLineDto {
  @ApiProperty({ format: 'uuid' })
  // 'loose' — never '4'/'all' (Story 1 trap; see attendance/dto/leave.dto.ts)
  @IsUUID('loose')
  membershipId!: string;

  @ApiProperty({ example: '2026-10' })
  @Matches(OFF_CYCLE_MONTH_PATTERN, {
    message: 'month must be a real month written as YYYY-MM',
  })
  month!: string;

  @ApiProperty({ example: 'Festival bonus', maxLength: 80 })
  @IsString()
  @MinLength(1, { message: 'label is required' })
  @MaxLength(80, {
    message: 'label must be at most 80 characters',
  })
  label!: string;

  @ApiProperty({
    example: 5000,
    description:
      'Positive = earning (bonus, arrear, correction); negative = recovery (needs the employer-liability acknowledgment); never zero.',
  })
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'amount must be a number with at most 2 decimal places' },
  )
  amount!: number;

  @ApiProperty({ enum: ['wage', 'bonus'], default: 'bonus' })
  @IsOptional()
  @IsIn(['wage', 'bonus'])
  tag?: 'wage' | 'bonus';

  @ApiProperty({
    default: false,
    description:
      'The employer-liability acknowledgment — REQUIRED for a negative (recovery) line, ignored otherwise.',
  })
  @IsOptional()
  @IsBoolean()
  acknowledged?: boolean;
}

export class UpdateOffCycleLineDto {
  @ApiProperty({ required: false, format: 'uuid' })
  @IsOptional()
  @IsUUID('loose') // never '4'/'all' (Story 1 trap; see leave.dto.ts)
  membershipId?: string;

  @ApiProperty({ required: false, example: '2026-11' })
  @IsOptional()
  @Matches(OFF_CYCLE_MONTH_PATTERN, {
    message: 'month must be a real month written as YYYY-MM',
  })
  month?: string;

  @ApiProperty({ required: false, example: 'Festival bonus', maxLength: 80 })
  @IsOptional()
  @IsString()
  @MinLength(1, { message: 'label is required' })
  @MaxLength(80, {
    message: 'label must be at most 80 characters',
  })
  label?: string;

  @ApiProperty({ required: false, example: 5000 })
  @IsOptional()
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'amount must be a number with at most 2 decimal places' },
  )
  amount?: number;

  @ApiProperty({ required: false, enum: ['wage', 'bonus'] })
  @IsOptional()
  @IsIn(['wage', 'bonus'])
  tag?: 'wage' | 'bonus';

  @ApiProperty({ required: false, default: false })
  @IsOptional()
  @IsBoolean()
  acknowledged?: boolean;
}

export class OffCycleLineView {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  membershipId!: string;

  @ApiProperty({
    description: 'The employee the line pays (or recovers from).',
  })
  employeeName!: string | null;

  @ApiProperty({ example: '2026-10' })
  month!: string;

  @ApiProperty({ example: 'Festival bonus' })
  label!: string;

  @ApiProperty({
    example: 5000,
    description: 'Signed: positive = earning, negative = recovery.',
  })
  amount!: number;

  @ApiProperty({ enum: ['wage', 'bonus'] })
  tag!: 'wage' | 'bonus';

  @ApiProperty({
    enum: ['staged', 'applied'],
    description:
      'staged = waiting for its month to run (or orphaned — the run skipped its employee); applied = on the month payslips.',
  })
  status!: 'staged' | 'applied';

  @ApiProperty({ description: 'When the line was staged.' })
  createdAt!: string;
}
