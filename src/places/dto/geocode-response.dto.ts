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
}
