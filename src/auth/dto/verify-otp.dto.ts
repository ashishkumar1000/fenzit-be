import { IsString, IsUUID, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class VerifyOtpDto {
  @IsUUID()
  @ApiProperty({
    description: 'OTP session ID returned from /auth/otp/send',
    example: '550e8400-e29b-41d4-a716-446655440000',
    format: 'uuid',
  })
  otpSessionId: string;

  @IsString()
  @Matches(/^\d{6}$/, {
    message: 'OTP code must be exactly 6 digits',
  })
  @ApiProperty({
    description: '6-digit OTP code sent to the phone number',
    example: '123456',
    pattern: '^\\d{6}$',
  })
  otpCode: string;
}
