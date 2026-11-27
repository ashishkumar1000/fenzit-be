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
 *
 * The `@ApiPropertyOptional` options are not documentation decoration: the
 * FE's employment contract is generated from this schema, so `maxLength`,
 * `pattern` and `format` must stay in step with the validators. The limits
 * live in one object so the two never disagree.
 */

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
const PAN_SHAPE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const IFSC_SHAPE = /^[A-Z]{4}[A-Z0-9]{7}$/;

const DATE_MESSAGE = 'must be a real calendar date written as YYYY-MM-DD';

const MAX = {
  employeeCode: 50,
  fatherName: 100,
  motherName: 100,
  spouseName: 100,
  pfAccountNumber: 50,
  uanNumber: 20,
  designation: 100,
  department: 100,
  bankAccountNumber: 35,
  bankName: 100,
} as const;

export class UpdateEmploymentDto {
  @ApiPropertyOptional({
    example: 'EMP-001',
    nullable: true,
    maxLength: MAX.employeeCode,
    description:
      'The tenant employee code. Once set it can be edited but never removed.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString({ message: 'employeeCode must be text' })
  @MaxLength(MAX.employeeCode, {
    message: `employeeCode must be at most ${MAX.employeeCode} characters`,
  })
  employeeCode?: string | null;

  @ApiPropertyOptional({
    example: '2026-09-01',
    nullable: true,
    format: 'date',
    description: 'Date of joining',
  })
  @IsOptional()
  @Transform(trim)
  @Matches(DATE_SHAPE, { message: `joinDate ${DATE_MESSAGE}` })
  joinDate?: string | null;

  @ApiPropertyOptional({
    example: '2026-10-10',
    nullable: true,
    format: 'date',
    description: 'Date of leaving; may be set on a removed member',
  })
  @IsOptional()
  @Transform(trim)
  @Matches(DATE_SHAPE, { message: `exitDate ${DATE_MESSAGE}` })
  exitDate?: string | null;

  @ApiPropertyOptional({
    example: 'ABCPE1234F',
    nullable: true,
    maxLength: 10,
    pattern: PAN_SHAPE.source,
  })
  @IsOptional()
  @Transform(trim)
  @Matches(PAN_SHAPE, {
    message:
      'pan must be 5 letters, then 4 digits, then 1 letter, in caps (like ABCDE1234F)',
  })
  pan?: string | null;

  @ApiPropertyOptional({
    example: '1995-04-12',
    nullable: true,
    format: 'date',
  })
  @IsOptional()
  @Transform(trim)
  @Matches(DATE_SHAPE, { message: `dateOfBirth ${DATE_MESSAGE}` })
  dateOfBirth?: string | null;

  @ApiPropertyOptional({
    example: 'Ramesh Sharma',
    nullable: true,
    maxLength: MAX.fatherName,
  })
  @IsOptional()
  @Transform(trim)
  @IsString({ message: 'fatherName must be text' })
  @MaxLength(MAX.fatherName, {
    message: `fatherName must be at most ${MAX.fatherName} characters`,
  })
  fatherName?: string | null;

  @ApiPropertyOptional({
    example: 'Sunita Sharma',
    nullable: true,
    maxLength: MAX.motherName,
  })
  @IsOptional()
  @Transform(trim)
  @IsString({ message: 'motherName must be text' })
  @MaxLength(MAX.motherName, {
    message: `motherName must be at most ${MAX.motherName} characters`,
  })
  motherName?: string | null;

  @ApiPropertyOptional({
    example: 'Meera Sharma',
    nullable: true,
    maxLength: MAX.spouseName,
  })
  @IsOptional()
  @Transform(trim)
  @IsString({ message: 'spouseName must be text' })
  @MaxLength(MAX.spouseName, {
    message: `spouseName must be at most ${MAX.spouseName} characters`,
  })
  spouseName?: string | null;

  @ApiPropertyOptional({
    example: 'PY/ABC/12345/000',
    nullable: true,
    maxLength: MAX.pfAccountNumber,
  })
  @IsOptional()
  @Transform(trim)
  @IsString({ message: 'pfAccountNumber must be text' })
  @MaxLength(MAX.pfAccountNumber, {
    message: `pfAccountNumber must be at most ${MAX.pfAccountNumber} characters`,
  })
  pfAccountNumber?: string | null;

  @ApiPropertyOptional({
    example: '101234567890',
    nullable: true,
    maxLength: MAX.uanNumber,
  })
  @IsOptional()
  @Transform(trim)
  @IsString({ message: 'uanNumber must be text' })
  @MaxLength(MAX.uanNumber, {
    message: `uanNumber must be at most ${MAX.uanNumber} characters`,
  })
  uanNumber?: string | null;

  @ApiPropertyOptional({
    example: 'Field Technician',
    nullable: true,
    maxLength: MAX.designation,
  })
  @IsOptional()
  @Transform(trim)
  @IsString({ message: 'designation must be text' })
  @MaxLength(MAX.designation, {
    message: `designation must be at most ${MAX.designation} characters`,
  })
  designation?: string | null;

  @ApiPropertyOptional({
    example: 'Field Operations',
    nullable: true,
    maxLength: MAX.department,
  })
  @IsOptional()
  @Transform(trim)
  @IsString({ message: 'department must be text' })
  @MaxLength(MAX.department, {
    message: `department must be at most ${MAX.department} characters`,
  })
  department?: string | null;

  @ApiPropertyOptional({
    example: '1234567890',
    nullable: true,
    maxLength: MAX.bankAccountNumber,
  })
  @IsOptional()
  @Transform(trim)
  @IsString({ message: 'bankAccountNumber must be text' })
  @MaxLength(MAX.bankAccountNumber, {
    message: `bankAccountNumber must be at most ${MAX.bankAccountNumber} characters`,
  })
  bankAccountNumber?: string | null;

  @ApiPropertyOptional({
    example: 'HDFC0001234',
    nullable: true,
    maxLength: 11,
    pattern: IFSC_SHAPE.source,
  })
  @IsOptional()
  @Transform(trim)
  @Matches(IFSC_SHAPE, {
    message:
      'ifscCode must be 4 letters followed by 7 letters or digits (like HDFC0001234)',
  })
  ifscCode?: string | null;

  @ApiPropertyOptional({
    example: 'HDFC Bank',
    nullable: true,
    maxLength: MAX.bankName,
  })
  @IsOptional()
  @Transform(trim)
  @IsString({ message: 'bankName must be text' })
  @MaxLength(MAX.bankName, {
    message: `bankName must be at most ${MAX.bankName} characters`,
  })
  bankName?: string | null;
}
