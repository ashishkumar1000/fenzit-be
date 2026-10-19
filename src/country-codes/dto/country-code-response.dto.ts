import { ApiProperty } from '@nestjs/swagger';

export class CountryCodeResponseDto {
  @ApiProperty({
    example: '+91',
    description: 'International dial code, with the plus sign',
  })
  dialCode: string;

  @ApiProperty({ example: 'India' })
  countryName: string;

  @ApiProperty({
    example: 'IN',
    description: 'ISO 3166-1 alpha-2 country code',
  })
  iso2: string;
}
