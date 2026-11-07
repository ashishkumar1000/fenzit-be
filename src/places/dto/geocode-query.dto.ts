import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { trim } from '../../common/utils/trim.transformer';

/**
 * Forward-geocode query. The server joins every filled part (address, city,
 * state, pincode) and adds India as the country filter, so staff get the best
 * match from all the data they have.
 */
export class GeocodeQueryDto {
  @ApiProperty({
    example: '12 MG Road',
    description: 'Street address (3–255 characters)',
  })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(255)
  address: string;

  @ApiPropertyOptional({ example: 'Bengaluru', description: 'City (max 100)' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  city?: string;

  @ApiPropertyOptional({ example: 'Karnataka', description: 'State (max 100)' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  state?: string;

  @ApiPropertyOptional({ example: '560001', description: 'PIN code (max 20)' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(20)
  pincode?: string;
}
