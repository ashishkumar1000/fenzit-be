import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';
import { Transform } from 'class-transformer';
import { trimArray } from '../../common/utils/trim.transformer';

export class MarkReadDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    maxItems: 100,
    description: 'Notification ids to mark read (own rows only; others no-op)',
  })
  // Trim each id through the shared trimmer (never a local copy) — the UUID
  // validator runs after the transform, so a padded id would otherwise 422.
  @Transform(trimArray)
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100) // the one client-controlled unbounded input — cap it
  @IsUUID(undefined, { each: true }) // never '4' (Story 1 IsUUID('4') trap)
  ids!: string[];
}
