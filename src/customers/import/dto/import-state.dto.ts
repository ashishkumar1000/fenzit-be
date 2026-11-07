import { IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { trim } from '../../../common/utils/trim.transformer';

/**
 * The import's state cell (up to 100 characters, same as city). Manual create
 * does not take state yet, so it is not on StructuredAddressDto. Declared here
 * so the rule is actually run: a property with no decorators is never checked.
 */
export class ImportStateDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  state?: string;
}
