import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

/**
 * 19-2's dashboard query. FR-24 is today only — no date params (the tiles
 * are a snapshot of attendance_today()); officeId filters today's
 * covering assignment office (D5). Malformed → 422 VALIDATION_ERROR;
 * unknown-but-well-formed → 200 with zeros + empty flags (a filter is not
 * an entity fetch — never 404).
 */
export class DashboardQueryDto {
  @ApiPropertyOptional({
    description: 'Filter to this office id (today’s covering assignment office)',
  })
  @IsOptional()
  @IsUUID('all', { message: 'officeId must be a UUID' })
  officeId?: string;
}
