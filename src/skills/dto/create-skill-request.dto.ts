import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, Matches } from 'class-validator';

/**
 * A company's ask for a skill that is missing from the global catalog.
 * The name is trimmed before validation, so "  Geyser  " is stored as "Geyser".
 * Length is counted in code points, the same unit Postgres uses for
 * char_length, so the API and the database accept the same names.
 * A whitespace-only name trims to empty and fails the same check.
 */
export class CreateSkillRequestDto {
  @ApiProperty({
    example: 'Geyser repair',
    minLength: 2,
    maxLength: 60,
    description:
      'The trade or skill the company wants added (2 to 60 characters)',
  })
  @Transform(({ value }: { value: unknown }): unknown =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Matches(/^[\s\S]{2,60}$/u, {
    message: 'Skill name must be 2 to 60 characters',
  })
  name!: string;
}
