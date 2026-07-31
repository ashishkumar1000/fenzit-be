import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class GetProfileQueryDto {
  @ApiPropertyOptional({
    description:
      'Opaque pagination cursor for the jobs list, from a previous response',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(512)
  jobsCursor?: string;

  @ApiPropertyOptional({
    description:
      'Opaque pagination cursor for the customers list (owner only), from a previous response',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(512)
  customersCursor?: string;
}
