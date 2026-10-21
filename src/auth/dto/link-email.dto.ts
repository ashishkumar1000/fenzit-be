import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength } from 'class-validator';

export class LinkEmailDto {
  @ApiProperty({
    example: 'owner@example.com',
    description:
      'Email to link to the signed-in user. Trimmed and lowercased before it is saved. One email belongs to one user.',
    maxLength: 254,
  })
  // Normalise before validating: the database stores lowercase only.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString()
  @MaxLength(254)
  @IsEmail()
  email: string;
}
