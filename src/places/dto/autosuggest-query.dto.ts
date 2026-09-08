import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { trim } from '../../common/utils/trim.transformer';

// Mirrors the frontend's client-side 3-character debounce gate (UX-DR3) —
// defense-in-depth so a direct API caller can't fire 1-2 char queries at the
// (billable) live provider. Kept in sync with the FE gate by convention.
export const MIN_AUTOSUGGEST_QUERY_LENGTH = 3;

export class AutosuggestQueryDto {
  @ApiProperty({
    example: 'andheri w',
    description: 'Free-text address query typed so far (minimum 3 characters)',
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MinLength(MIN_AUTOSUGGEST_QUERY_LENGTH)
  @MaxLength(100)
  q: string;

  @ApiProperty({
    example: 'a1b2c3d4-0000-4000-8000-000000000001',
    description:
      'Client-generated token grouping one autosuggest typing session (mirrors Google Places Autocomplete session-token semantics)',
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  sessionToken: string;
}
