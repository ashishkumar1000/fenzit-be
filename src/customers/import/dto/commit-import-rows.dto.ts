import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { trimToUndefined } from '../../../common/utils/trim.transformer';
import { ValidateImportRowsDto } from './validate-import-rows.dto';

/** Same body as validate, plus the file name kept on the import record. */
export class CommitImportRowsDto extends ValidateImportRowsDto {
  @ApiPropertyOptional({
    example: 'owners-may.xlsx',
    maxLength: 255,
    description:
      'Name of the uploaded file, kept on the import record. Defaults to import.csv.',
  })
  @IsOptional()
  @Transform(trimToUndefined)
  @IsString()
  @MaxLength(255, { message: 'fileName must be 255 characters or fewer' })
  fileName?: string;
}
