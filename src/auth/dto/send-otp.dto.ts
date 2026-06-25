import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

export class SendOtpDto {
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
