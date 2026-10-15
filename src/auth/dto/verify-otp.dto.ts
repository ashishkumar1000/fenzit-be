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

  // 4 digits — the real OTP (user-directed, 2026-10-15) AND the pre-release
  // master code (re-keyed to 1039 the same day), so the regex has a single
  // arm. The old 6-digit arm died with the 816001 master code.
  @IsString()
  @Matches(/^\d{4}$/, {
    message: 'OTP code must be 4 digits',
  })
  @ApiProperty({
    description: '4-digit OTP code sent to the phone number',
    example: '1234',
    pattern: '^\\d{4}$',
  })
  otpCode: string;
}
