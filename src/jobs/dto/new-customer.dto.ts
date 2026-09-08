import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
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

  // Structured-address fields mirror CreateCustomerDto exactly, so both
  // customer-creation entry points accept the same payload shape.
  @ApiPropertyOptional({
    example: '12 MG Road, Bengaluru, Karnataka 560001, India',
    description: 'Formatted address from the places autosuggest/resolve flow',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  formattedAddress?: string;

  @ApiPropertyOptional({ example: '560001', description: 'Postal/PIN code' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(20)
  @Matches(/^[1-9][0-9]{5}$/, {
    message: 'pincode must be a valid 6-digit Indian PIN code',
  })
  pincode?: string;

  @ApiPropertyOptional({ example: 12.9716, description: 'Latitude' })
  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude?: number;

  @ApiPropertyOptional({ example: 77.5946, description: 'Longitude' })
  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude?: number;

  @ApiPropertyOptional({
    example: 'ChIJbU60yXAWrjsR4E9-UejD3_g',
    description: 'Places provider place id',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(255)
  placeId?: string;
}
