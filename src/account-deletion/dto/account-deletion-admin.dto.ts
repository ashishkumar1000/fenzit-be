import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

export const DELETION_QUEUE_STATUSES = [
  'open',
  'completed',
  'rejected',
] as const;
export type DeletionQueueStatus = (typeof DELETION_QUEUE_STATUSES)[number];

export const DELETION_RESOLVE_ACTIONS = ['complete', 'reject'] as const;
export type DeletionResolveAction = (typeof DELETION_RESOLVE_ACTIONS)[number];

export class ListAccountDeletionRequestsQueryDto {
  @ApiPropertyOptional({ enum: DELETION_QUEUE_STATUSES, default: 'open' })
  @IsOptional()
  @IsIn(DELETION_QUEUE_STATUSES)
  status?: DeletionQueueStatus;
}

export class ResolveAccountDeletionRequestDto {
  @ApiProperty({
    enum: DELETION_RESOLVE_ACTIONS,
    description:
      'complete = marked as handled by staff (this does not delete any data by itself); reject = no deletion',
  })
  @IsIn(DELETION_RESOLVE_ACTIONS)
  action: DeletionResolveAction;
}
