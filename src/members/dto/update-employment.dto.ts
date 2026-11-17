import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * A body key that is present means "set it", absent means "leave it alone",
 * and JSON null means "clear it" — the service tells the three apart by
 * `undefined` vs `null` vs a value, so every field is optional here and the
 * null case skips validation on purpose.
 *
 * Text values are trimmed first; a value that is empty after the trim is a
 * clear. The employee code is the one exception: it can never be cleared.
 */

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
const PAN_SHAPE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const IFSC_SHAPE = /^[A-Z]{4}[A-Z0-9]{7}$/;

const DATE_MESSAGE = 'must be a real calendar date written as YYYY-MM-DD';

export class UpdateEmploymentDto {
  @ApiPropertyOptional({
    example: 'EMP-001',
    nullable: true,
    description:
      'The tenant employee code. Once set it can be edited but never removed.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString({ message: 'employeeCode must be text' })
  @MaxLength(50, { message: 'employeeCode must be at most 50 characters' })
  employeeCode?: string | null;

  @ApiPropertyOptional({
    example: '2026-09-01',
    nullable: true,
    description: 'Date of joining',
  })
  @IsOptional()
  @Transform(trim)
  @Matches(DATE_SHAPE, { message: `joinDate ${DATE_MESSAGE}` })
  joinDate?: string | null;

  @ApiPropertyOptional({
    example: '2026-10-10',
    nullable: true,
    description: 'Date of leaving; may be set on a removed member',
  })
  @IsOptional()
  @Transform(trim)
  @Matches(DATE_SHAPE, { message: `exitDate ${DATE_MESSAGE}` })
  exitDate?: string | null;

  @ApiPropertyOptional({ example: 'ABCPE1234F', nullable: true })
  @IsOptional()
  @Transform(trim)
  @Matches(PAN_SHAPE, {
    message:
      'pan must be 5 letters, then 4 digits, then 1 letter, in caps (like ABCDE1234F)',
  })
  pan?: string | null;

  @ApiPropertyOptional({ example: '1995-04-12', nullable: true })
  @IsOptional()
  @Transform(trim)
  @Matches(DATE_SHAPE, { message: `dateOfBirth ${DATE_MESSAGE}` })
  dateOfBirth?: string | null;

  @ApiPropertyOptional({ example: 'Ramesh Sharma', nullable: true })
  @IsOptional()
  @Transform(trim)
  @IsString({ message: 'fatherName must be text' })
  @MaxLength(100, { message: 'fatherName must be at most 100 characters' })
  fatherName?: string | null;

  @ApiPropertyOptional({ example: 'Sunita Sharma', nullable: true })
  @IsOptional()
  @Transform(trim)
  @IsString({ message: 'motherName must be text' })
  @MaxLength(100, { message: 'motherName must be at most 100 characters' })
  motherName?: string | null;

  @ApiPropertyOptional({ example: 'Meera Sharma', nullable: true })
  @IsOptional()
  @Transform(trim)
  @IsString({ message: 'spouseName must be text' })
  @MaxLength(100, { message: 'spouseName must be at most 100 characters' })
  spouseName?: string | null;

  @ApiPropertyOptional({ example: 'PY/ABC/12345/000', nullable: true })
  @IsOptional()
  @Transform(trim)
  @IsString({ message: 'pfAccountNumber must be text' })
  @MaxLength(50, {
    message: 'pfAccountNumber must be at most 50 characters',
  })
  pfAccountNumber?: string | null;

  @ApiPropertyOptional({ example: '101234567890', nullable: true })
  @IsOptional()
  @Transform(trim)
  @IsString({ message: 'uanNumber must be text' })
  @MaxLength(20, { message: 'uanNumber must be at most 20 characters' })
  uanNumber?: string | null;

  @ApiPropertyOptional({ example: 'Field Technician', nullable: true })
  @IsOptional()
  @Transform(trim)
  @IsString({ message: 'designation must be text' })
  @MaxLength(100, { message: 'designation must be at most 100 characters' })
  designation?: string | null;

  @ApiPropertyOptional({ example: 'Field Operations', nullable: true })
  @IsOptional()
  @Transform(trim)
  @IsString({ message: 'department must be text' })
  @MaxLength(100, { message: 'department must be at most 100 characters' })
  department?: string | null;

  @ApiPropertyOptional({ example: '1234567890', nullable: true })
  @IsOptional()
  @Transform(trim)
  @IsString({ message: 'bankAccountNumber must be text' })
  @MaxLength(35, {
    message: 'bankAccountNumber must be at most 35 characters',
  })
  bankAccountNumber?: string | null;

  @ApiPropertyOptional({ example: 'HDFC0001234', nullable: true })
  @IsOptional()
  @Transform(trim)
  @Matches(IFSC_SHAPE, {
    message:
      'ifscCode must be 4 letters followed by 7 letters or digits (like HDFC0001234)',
  })
  ifscCode?: string | null;

  @ApiPropertyOptional({ example: 'HDFC Bank', nullable: true })
  @IsOptional()
  @Transform(trim)
  @IsString({ message: 'bankName must be text' })
  @MaxLength(100, { message: 'bankName must be at most 100 characters' })
  bankName?: string | null;
}
