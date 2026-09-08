import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { trim } from '../../common/utils/trim.transformer';
import { StructuredAddressDto } from '../../common/dto/structured-address.dto';

export class CreateCustomerDto extends StructuredAddressDto {
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
}
