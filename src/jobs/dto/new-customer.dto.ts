import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

// Mirrors the file-local `trim` helper in customers/dto/create-customer.dto.ts
// (that one is not exported).
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Inline customer payload for job creation (find-or-create by phone).
 * Field validators are identical to CreateCustomerDto so the dedup path reuses
 * the same (country_code, phone_number) shape and country_codes FK.
 */
export class NewCustomerDto {
  @ApiProperty({ example: 'Priya Sharma', description: 'Customer full name' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'name must not be empty or whitespace' })
  @MaxLength(120)
  name: string;

  @ApiProperty({ example: '+91', description: 'Dial code (e.g. +91, +1, +44)' })
  @IsString()
  @Matches(/^\+\d{1,4}$/, {
    message: 'countryCode must be a valid dial code (e.g. +91)',
  })
  countryCode: string;

  @ApiProperty({
    example: '9876543210',
    description: 'Subscriber number without country code',
  })
  @IsString()
  @Matches(/^\d{6,15}$/, { message: 'phoneNumber must be 6–15 digits' })
  phoneNumber: string;

  @ApiPropertyOptional({ example: '12 MG Road', description: 'Street address' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(255)
  address?: string;

  @ApiPropertyOptional({ example: 'Bengaluru', description: 'City' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  city?: string;
}
