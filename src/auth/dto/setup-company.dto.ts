import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

export class SetupCompanyDto {
  @ApiProperty({ example: 'Jobzo Services Pvt Ltd' })
  @IsString()
  @IsNotEmpty({ message: 'companyName must not be empty or whitespace' })
  @MinLength(1)
  companyName: string;

  @ApiProperty({
    example: 'KA',
    description: 'ISO 3166-2:IN 2-letter state code (uppercase)',
  })
  @IsString()
  @Matches(/^[A-Z]{2}$/, {
    message: 'stateCode must be a 2-letter uppercase code (e.g. KA, MH)',
  })
  stateCode: string;

  @ApiPropertyOptional({
    example: '29ABCDE1234F1Z5',
    description: 'GST Identification Number',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/, {
    message: 'Invalid GSTIN format',
  })
  gstin?: string;

  @ApiPropertyOptional({ example: '12 MG Road, Bengaluru 560001' })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional({
    type: [String],
    example: ['ac_technician', 'pest_control'],
  })
  @IsOptional()
  @Transform(({ value }) =>
    Array.isArray(value)
      ? value.map((s: unknown) => (typeof s === 'string' ? s.trim() : s))
      : value,
  )
  @IsArray()
  @IsString({ each: true })
  @IsNotEmpty({
    each: true,
    message: 'each serviceCategory must not be empty or whitespace',
  })
  @MaxLength(100, {
    each: true,
    message: 'each serviceCategory must be at most 100 characters',
  })
  serviceCategories?: string[];

  @ApiPropertyOptional({ example: 'jobzo@upi' })
  @IsOptional()
  @IsString()
  upiVpa?: string;
}
