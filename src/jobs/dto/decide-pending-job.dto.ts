import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class DecidePendingJobDto {
  @ApiProperty({ enum: ['approve', 'reject'] })
  @IsIn(['approve', 'reject'], {
    message: 'decision must be approve or reject',
  })
  decision: 'approve' | 'reject';

  @ApiPropertyOptional({
    maxLength: 500,
    description: 'Why the job was rejected. Optional, even when rejecting.',
  })
  @IsOptional()
  @IsString({ message: 'reason must be text' })
  @MaxLength(500, { message: 'reason must be 500 characters or fewer' })
  reason?: string;
}
