import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

export class SendOtpDto {
  // Sign-in by phone supports India only for now. The send route refuses any other
  // dial code here, before any SMS is sent. Widening this list is a deliberate
  // product decision and needs its own change.
  @ApiProperty({ example: '+91', description: 'Dial code. Only +91 is supported.' })
  @IsString()
  @Matches(/^\+91$/, {
    message: 'countryCode must be +91. Only Indian numbers can sign in by phone.',
  })
  countryCode: string;

  @ApiProperty({
    example: '9876543210',
    description: 'Indian mobile number without the country code',
  })
  @IsString()
  @Matches(/^\d{10}$/, { message: 'phoneNumber must be 10 digits' })
  phoneNumber: string;
}
