import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { trim } from '../../common/utils/trim.transformer';

/**
 * The 7 optional structured-address fields shared by every customer-creation
 * entry point (manual create + find-or-create on the jobs path). Declared once
 * as a base class — class-validator validates inherited decorated properties,
 * and @nestjs/swagger includes them in the model schema — so the validators,
 * examples and max-lengths can never drift between the two DTOs (they were
 * previously copy-pasted in both).
 */
export class StructuredAddressDto {
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
