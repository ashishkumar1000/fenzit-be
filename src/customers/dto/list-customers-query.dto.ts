import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class ListCustomersQueryDto {
  @ApiPropertyOptional({
    example: 'priya',
    description:
      'Case-insensitive partial match on customer name or phone number',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({
    description: 'Opaque pagination cursor from a previous response',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(512)
  cursor?: string;
}
