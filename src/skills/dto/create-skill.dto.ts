import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

export class CreateSkillDto {
  @ApiProperty({
    example: 'AC Technician',
    description: 'Skill name (unique per tenant, case-insensitive)',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty({ message: 'name must not be empty or whitespace' })
  @MaxLength(100)
  name: string;
}
