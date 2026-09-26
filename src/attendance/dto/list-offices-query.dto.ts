import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

export class ListOfficesQueryDto {
  @ApiPropertyOptional({
    enum: ['true', 'false'],
    description: 'Set to "true" to include archived offices',
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  includeArchived?: string;
}