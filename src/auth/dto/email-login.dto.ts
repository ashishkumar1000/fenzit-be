import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';

// DEV SHORTCUT — remove at go-live gate (see email-login.constants.ts)
export class EmailLoginDto {
  @ApiProperty({
    example: 'admin@fenzit.com',
    description:
      'Email linked to the user. Trimmed and lowercased before lookup.',
    maxLength: 254,
  })
  // Normalise before validating so " Admin@Fenzit.com " matches the stored
  // lowercase value (users_email_format forces lowercase).
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString()
  @MaxLength(254)
  @IsEmail()
  email: string;

  @ApiProperty({
    description: 'The fixed development password',
    maxLength: 128,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  password: string;
}
