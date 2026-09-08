import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Swagger-facing shape of one GET /customers list item. Mirrors the service's
 * `CustomerListItem` interface (a CustomerResponse-like row plus jobCount and
 * lastJobDate), declared as a class so @ApiProperty can document it.
 */
export class CustomerListItemDto {
  @ApiProperty({ example: 'a1b2c3d4-0000-4000-8000-000000000002' })
  id: string;

  @ApiProperty({ example: 'Priya Sharma' })
  name: string;

  @ApiProperty({ example: '+91' })
  countryCode: string;

  @ApiProperty({ example: '+919876543210' })
  phoneNumber: string;

  @ApiPropertyOptional({ example: '12 MG Road', nullable: true })
  address: string | null;

  @ApiPropertyOptional({ example: 'Bengaluru', nullable: true })
  city: string | null;

  @ApiPropertyOptional({
    example: '12 MG Road, Bengaluru, Karnataka 560001, India',
    nullable: true,
  })
  formattedAddress: string | null;

  @ApiPropertyOptional({ example: '560001', nullable: true })
  pincode: string | null;

  @ApiPropertyOptional({ example: 12.9716, nullable: true })
  latitude: number | null;

  @ApiPropertyOptional({ example: 77.5946, nullable: true })
  longitude: number | null;

  @ApiPropertyOptional({
    example: 'ChIJbU60yXAWrjsR4E9-UejD3_g',
    nullable: true,
  })
  placeId: string | null;

  @ApiProperty({
    example: 3,
    description: 'Jobs of any status for this customer',
  })
  jobCount: number;

  @ApiPropertyOptional({ example: '2026-09-01T10:00:00.000Z', nullable: true })
  lastJobDate: string | null;
}
