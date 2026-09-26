import { ApiProperty } from '@nestjs/swagger';

export class ReverseGeocodedAddressDto {
  @ApiProperty({
    example: 'Andheri West, Mumbai, Maharashtra 400058, India',
    nullable: true,
    description:
      'null when the point has no address (e.g. open water) — the caller falls back to showing the raw coordinates',
  })
  formattedAddress: string | null;

  @ApiProperty({
    example: 'Mumbai',
    nullable: true,
    description: 'null when the point has no city (locality) component',
  })
  city: string | null;

  @ApiProperty({
    example: '400058',
    nullable: true,
    description: 'null when the point has no pincode component',
  })
  pincode: string | null;
}
