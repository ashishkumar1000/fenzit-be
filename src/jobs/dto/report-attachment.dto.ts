import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export const ATTACHMENT_REPORT_REASONS = [
  'inappropriate',
  'harassment',
  'spam',
  'other',
] as const;

export type AttachmentReportReason = (typeof ATTACHMENT_REPORT_REASONS)[number];

export class ReportAttachmentDto {
  @ApiProperty({
    enum: ATTACHMENT_REPORT_REASONS,
    description: 'Why the photo is being reported',
  })
  @IsIn(ATTACHMENT_REPORT_REASONS)
  reason: AttachmentReportReason;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
