import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateBy,
} from 'class-validator';
import { normalizePhone } from '../../early-access/dto/create-early-access.dto';

export const CONTACT_REQUEST_KINDS = ['call_back', 'demo'] as const;
export type ContactRequestKind = (typeof CONTACT_REQUEST_KINDS)[number];

const trimmed = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

// Postgres text cannot hold a NUL byte. Without this check the insert fails and the
// visitor gets a 500 instead of a clear 422.
function NoNulByte(): PropertyDecorator {
  return ValidateBy({
    name: 'noNulByte',
    validator: {
      validate: (value: unknown) =>
        typeof value !== 'string' || !value.includes('\u0000'),
      defaultMessage: () => 'must not contain a NUL character',
    },
  });
}

/**
 * A call-back or demo request from the public site. Every text field is
 * optional except the kind, but at least one of email or phone must be given.
 * That rule is checked in the service (400), and the table repeats it as a CHECK (422).
 */
export class CreateContactRequestDto {
  @ApiProperty({
    enum: CONTACT_REQUEST_KINDS,
    example: 'call_back',
    description: 'call_back = "call me"; demo = "book a demo".',
  })
  @IsIn(CONTACT_REQUEST_KINDS)
  kind: ContactRequestKind;

  @ApiPropertyOptional({ example: 'Ravi Kumar' })
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(120)
  @NoNulByte()
  name?: string;

  @ApiPropertyOptional({ example: 'Kumar Repairs' })
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(120)
  @NoNulByte()
  company?: string;

  @ApiPropertyOptional({
    example: 'owner@example.com',
    description: 'Email address. Stored lower-cased.',
  })
  @IsOptional()
  // A blank field counts as "no email", the same as a blank phone.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() || undefined : value,
  )
  @IsString()
  @MaxLength(254)
  // Same shape as the table's CHECK, so an address the table would refuse gets a 422 here.
  @Matches(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, { message: 'email must be an email' })
  @NoNulByte()
  email?: string;

  @ApiPropertyOptional({
    example: '+91 98765 43210',
    description:
      'Phone with its country code, stored in E.164 form. A 10-digit Indian mobile without a code is read as +91.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => normalizePhone(value))
  @Matches(/^\+[1-9]\d{6,14}$/, {
    message: 'phone must include the country code, for example +91 98765 43210',
  })
  phone?: string;

  @ApiPropertyOptional({
    example: 'We have 12 technicians.',
    description: 'Anything the person wants us to know.',
  })
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(500)
  @NoNulByte()
  note?: string;
}
