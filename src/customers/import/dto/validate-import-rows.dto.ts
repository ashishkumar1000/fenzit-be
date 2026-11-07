import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  Matches,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { trimToUndefined } from '../../../common/utils/trim.transformer';
import { IMPORT_MAX_ROWS } from '../import-rows.types';

export class ValidateImportRowsDto {
  @ApiPropertyOptional({
    example: '+91',
    description:
      'Country picked for the whole sheet. Rows with no dial code of their own use it.',
  })
  @IsOptional()
  @Transform(trimToUndefined)
  @Matches(/^\+\d{1,4}$/, {
    message: 'defaultCountryCode must be a valid dial code (e.g. +91)',
  })
  defaultCountryCode?: string;

  // Items are not validated here on purpose: a bad row must come back as a
  // per-row reason, not fail the whole sheet with a 422.
  @ApiProperty({
    type: 'array',
    maxItems: IMPORT_MAX_ROWS,
    description:
      'Sheet rows. Each row: name, address and phone (required); latitude and longitude (both or neither); city, state, pincode and address_details (optional).',
    items: { type: 'object' },
  })
  @IsArray()
  @ArrayMinSize(1, { message: 'rows must contain at least one row' })
  @ArrayMaxSize(IMPORT_MAX_ROWS, {
    message: `rows must contain at most ${IMPORT_MAX_ROWS} rows`,
  })
  rows: unknown[];
}
