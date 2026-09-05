import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { trim } from '../../common/utils/trim.transformer';

export class AutosuggestQueryDto {
  @ApiProperty({
    example: 'andheri w',
    description: 'Free-text address query typed so far',
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
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
