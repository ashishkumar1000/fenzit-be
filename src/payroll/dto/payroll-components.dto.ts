import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Salary component library DTOs (CAP-1). name / isBasic / active have NO
 * clear verb — a component is renamed, re-flagged or deactivated, never
 * partially emptied — so a JSON null reaches the service, which answers 422
 * (IsOptional deliberately lets it past the pipe). Tri-state handling
 * mirrors the leave-type and employment DTOs: absent = untouched, null =
 * refused where no clear verb exists, value = set.
 */
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateSalaryComponentDto {
  @ApiProperty({
    example: 'Basic',
    description:
      'Library name, unique inside the company (1-60 characters). This is the name payslip lines print.',
  })
  @Transform(trim)
  @IsString({ message: 'name must be text' })
  @IsNotEmpty({ message: 'name must not be empty or whitespace' })
  @MaxLength(60, { message: 'name must be at most 60 characters' })
  name!: string;

  @ApiPropertyOptional({
    example: true,
    description:
      'Designate this component as THE basic component (the PF base / Form V basic line). Rejected while another component already holds the designation.',
  })
  @IsOptional()
  @IsBoolean({ message: 'isBasic must be true or false' })
  isBasic?: boolean;
}

export class UpdateSalaryComponentDto {
  @ApiPropertyOptional({
    example: 'Basic Pay',
    nullable: true,
    description:
      'New library name (unique inside the company). Renames are legal and reach the next payroll run; null is refused.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString({ message: 'name must be text' })
  @MaxLength(60, { message: 'name must be at most 60 characters' })
  name?: string | null;

  @ApiPropertyOptional({
    example: true,
    nullable: true,
    description:
      'Move the basic designation. true is refused while another component already holds it — clear that one first; null is refused.',
  })
  @IsOptional()
  @IsBoolean({ message: 'isBasic must be true or false' })
  isBasic?: boolean | null;

  @ApiPropertyOptional({
    example: false,
    nullable: true,
    description:
      'Deactivate (false) or reactivate (true). Deactivation is refused while any employee structure still references the component; null is refused.',
  })
  @IsOptional()
  @IsBoolean({ message: 'active must be true or false' })
  active?: boolean | null;
}

/** A library row as the API answers it (list/create/update). */
export class SalaryComponentView {
  @ApiProperty({ example: '8f6ad6cd-0f2e-4d9a-9c6d-6f0d1a2b3c4d' })
  id: string;

  @ApiProperty({ example: 'Basic' })
  name: string;

  @ApiProperty({
    example: true,
    description:
      'The one basic component of the company (PF base, Form V basic/DA line).',
  })
  isBasic: boolean;

  @ApiProperty({
    example: true,
    description: 'false = deactivated; it cannot appear in any structure.',
  })
  active: boolean;

  @ApiProperty({ example: '2026-11-17T10:00:00.000Z' })
  createdAt: string;

  @ApiProperty({ example: '2026-11-17T10:00:00.000Z' })
  updatedAt: string;
}
