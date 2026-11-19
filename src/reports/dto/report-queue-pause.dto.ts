import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { MAX_PAUSE_MINUTES } from '../report-queue.service';

/**
 * 23-8: the body of POST /reports/queue/pause. `minutes` absent = pause
 * indefinitely (until someone resumes); present = a timed pause that
 * auto-expires — a maintenance window, capped at a day.
 */
export class ReportQueuePauseDto {
  @ApiPropertyOptional({
    description:
      'Pause for this many minutes (1–1440). Omit to pause indefinitely.',
    type: Number,
    minimum: 1,
    maximum: MAX_PAUSE_MINUTES,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAUSE_MINUTES)
  minutes?: number;
}
