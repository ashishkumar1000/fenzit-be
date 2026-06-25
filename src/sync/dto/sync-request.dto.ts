import { IsISO8601, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class SyncRequestDto {
  @ApiPropertyOptional({
    description:
      'ISO 8601 timestamp of the last successful sync. Omit for initial sync.',
    example: '2026-06-21T10:00:00.000Z',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  lastSyncedAt?: string;
}
