import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { GSTIN_PATTERN } from '../../common/validators/gstin';

/** Upper bound on how many business types one company can pick. */
export const MAX_BUSINESS_TYPES_PER_COMPANY = 10;

/**
 * Owner-only company details. Every field is optional; a field that is absent
 * is left as it is. `gstin: null` (or an empty string) clears the GSTIN.
 */
export class UpdateCompanyDto {
  @ApiPropertyOptional({
    example: '29ABCDE1234F1Z5',
    nullable: true,
    description: 'GST number, 15 characters. Send null or "" to clear it.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() || null : value,
  )
  @IsString()
  @Matches(GSTIN_PATTERN, { message: 'Invalid GSTIN format' })
  gstin?: string | null;

  @ApiPropertyOptional({
    type: [String],
    example: ['ac_hvac', 'electrical'],
    description:
      'Business type codes from GET /business-types. Replaces the whole set.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1, { message: 'Pick at least one business type' })
  @ArrayMaxSize(MAX_BUSINESS_TYPES_PER_COMPANY, {
    message: `Pick at most ${MAX_BUSINESS_TYPES_PER_COMPANY} business types`,
  })
  @ArrayUnique()
  @IsString({ each: true })
  @Matches(/^[a-z][a-z0-9_]*$/, { each: true })
  businessTypeCodes?: string[];
}
