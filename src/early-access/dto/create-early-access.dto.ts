import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, Matches, MaxLength } from 'class-validator';

/**
 * Turns a typed phone number into E.164 (a plus sign, country code, number).
 * Spaces, hyphens, brackets and dots are removed first. A blank value becomes
 * undefined, so an empty phone field counts as "no phone".
 *
 * Two conveniences, and no others: "00" as an international prefix becomes "+",
 * and a bare 10-digit number starting 6-9 is read as an Indian mobile (+91).
 * Everything else must already carry its country code and is rejected by the
 * Matches rule below if it is not valid E.164.
 */
export function normalizePhone(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const cleaned = value.replace(/[\s\-().]/g, '');
  if (cleaned === '') return undefined;
  if (/^00[1-9]\d{6,14}$/.test(cleaned)) return `+${cleaned.slice(2)}`;
  if (/^[6-9]\d{9}$/.test(cleaned)) return `+91${cleaned}`;
  return cleaned;
}

export class CreateEarlyAccessDto {
  @ApiProperty({
    example: 'owner@example.com',
    description: 'Email address. Stored lower-cased; one row per address.',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  // Same shape as the table's CHECK, so an address the table would refuse gets a 422 here.
  @Matches(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, { message: 'email must be an email' })
  email: string;

  @ApiPropertyOptional({
    example: '+44 20 7946 0958',
    description:
      'Optional phone number from any country, with its country code. Stored in E.164 form (+ then 7-15 digits). A 10-digit Indian mobile without a code is read as +91.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => normalizePhone(value))
  @Matches(/^\+[1-9]\d{6,14}$/, {
    message:
      'phone must include the country code, for example +44 20 7946 0958 or +91 98765 43210',
  })
  phone?: string;
}
