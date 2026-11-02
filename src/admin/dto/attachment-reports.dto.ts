import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

export const REPORT_QUEUE_STATUSES = ['open', 'hidden', 'dismissed'] as const;
export type ReportQueueStatus = (typeof REPORT_QUEUE_STATUSES)[number];

export const RESOLVE_ACTIONS = ['hide', 'dismiss'] as const;
export type ResolveAction = (typeof RESOLVE_ACTIONS)[number];

export class ListAttachmentReportsQueryDto {
  @ApiPropertyOptional({ enum: REPORT_QUEUE_STATUSES, default: 'open' })
  @IsOptional()
  @IsIn(REPORT_QUEUE_STATUSES)
  status?: ReportQueueStatus;
}

export class ResolveAttachmentReportDto {
  @ApiProperty({
    enum: RESOLVE_ACTIONS,
    description: 'hide = take the photo off every device; dismiss = keep it',
  })
  @IsIn(RESOLVE_ACTIONS)
  action: ResolveAction;
}
