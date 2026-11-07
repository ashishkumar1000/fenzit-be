import { IsOptional, IsString } from 'class-validator';
import { Transform } from 'class-transformer';
import { trim } from '../../../common/utils/trim.transformer';
import { MaxCodePoints } from '../../../common/validators/max-code-points';

/**
 * The import's state cell (up to 100 characters, same as city). Manual create
 * does not take state yet, so it is not on StructuredAddressDto. Declared here
 * so the rule is actually run: a property with no decorators is never checked.
 */
export class ImportStateDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxCodePoints(100)
  state?: string;
}
