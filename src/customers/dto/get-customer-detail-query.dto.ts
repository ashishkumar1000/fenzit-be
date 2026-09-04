import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { trimToUndefined } from '../../common/utils/trim.transformer';

export class GetCustomerDetailQueryDto {
  @ApiPropertyOptional({
    description: 'Opaque pagination cursor for the job history page',
  })
  @IsOptional()
  @Transform(trimToUndefined)
  @IsString()
  @MaxLength(512)
  cursor?: string;
}
