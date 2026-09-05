import { ApiProperty } from '@nestjs/swagger';

export class ResolvedPlaceDto {
  @ApiProperty({ example: 'mock-place-andheri-west-1' })
  placeId: string;

  @ApiProperty({
    example: 'Andheri West, Mumbai, Maharashtra 400058, India',
  })
  formattedAddress: string;

  @ApiProperty({
    example: 'Mumbai',
    nullable: true,
    description: 'null when the resolved place has no city component',
  })
  city: string | null;

  @ApiProperty({
    example: '400058',
    nullable: true,
    description: 'null when the resolved place has no pincode component',
  })
  pincode: string | null;

  @ApiProperty({ example: 19.1364 })
  latitude: number;

  @ApiProperty({ example: 72.8296 })
  longitude: number;
}
