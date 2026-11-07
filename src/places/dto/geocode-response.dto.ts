import { ApiProperty } from '@nestjs/swagger';

export class GeocodeResponseDto {
  @ApiProperty({
    nullable: true,
    example: 'MG Road, Bengaluru, Karnataka, India',
  })
  formattedAddress: string | null;

  @ApiProperty({ nullable: true, example: 12.9759 })
  latitude: number | null;

  @ApiProperty({ nullable: true, example: 77.6068 })
  longitude: number | null;

  @ApiProperty({
    example: false,
    description:
      'True when only an area centre was found (no street-level match). Check the pin before saving.',
  })
  approximate: boolean;

  @ApiProperty({ nullable: true, example: 'Bengaluru' })
  city: string | null;

  @ApiProperty({ nullable: true, example: 'Karnataka' })
  state: string | null;

  @ApiProperty({ nullable: true, example: '560001' })
  pincode: string | null;
}
