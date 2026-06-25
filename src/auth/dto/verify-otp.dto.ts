import { IsString, IsUUID, Matches } from 'class-validator';

export class VerifyOtpDto {
  @IsUUID()
  otpSessionId: string;

  @IsString()
  @Matches(/^\d{6}$/, {
    message: 'OTP code must be exactly 6 digits',
  })
  otpCode: string;
}
