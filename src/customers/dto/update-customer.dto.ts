import { ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { trim } from '../../common/utils/trim.transformer';
import { StructuredAddressDto } from '../../common/dto/structured-address.dto';

/**
 * Body for `PATCH /api/v1/customers/:id` (SPEC-edit-customer CAP-4).
 *
 * Only the mutable fields are exposed. This deliberately extends
 * PartialType(StructuredAddressDto) rather than PartialType(CreateCustomerDto):
 * the address base carries exactly the eight optional structured-address
 * fields, so `countryCode`/`phoneNumber` are structurally absent from the
 * schema — the phone is immutable in v1 and can never be read or changed via
 * PATCH (same mutable-subset philosophy as update-job.dto.ts). The global
 * ValidationPipe (`whitelist: true`) silently strips any phone keys a client
 * sends anyway — never a rejection.
 *
 * Every field is optional; a key that is present with `null` clears the
 * column (manual-entry clear of the picked-location block), while an absent
 * key leaves it untouched — the service distinguishes the two by presence.
 * `addressDetails` is only ever cleared by an explicit `null` (CAP-5: a re-pin
 * never clears it). An empty body → 400 "Nothing to update".
 */
export class UpdateCustomerDto extends PartialType(StructuredAddressDto) {
  @ApiPropertyOptional({
    example: 'Priya Sharma',
    description: 'Customer full name (optional but non-empty when present)',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'name must not be empty or whitespace' })
  @MaxLength(120)
  name?: string;
}
