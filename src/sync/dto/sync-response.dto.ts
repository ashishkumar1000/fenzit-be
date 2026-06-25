import { ApiProperty } from '@nestjs/swagger';

export interface AttachmentSummary {
  id: string;
  attachmentType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface SyncCustomer {
  name: string;
  address: string | null;
}

export interface SyncJobDto {
  id: string;
  jobNumber: string;
  tenantId: string;
  customerId: string;
  technicianId: string;
  serviceLocation: string;
  serviceType: string;
  scheduledStart: string;
  scheduledEnd: string | null;
  status: string;
  currentStep: string | null;
  priority: string;
  requireCompletionPhoto: boolean;
  description: string | null;
  notesForTechnician: string | null;
  createdAt: string;
  updatedAt: string;
  customer: SyncCustomer;
  attachments: AttachmentSummary[];
}

export class SyncResponseDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    isArray: true,
    description: 'Jobs changed since last_synced_at',
  })
  jobs: SyncJobDto[];

  @ApiProperty({
    description:
      'UTC server timestamp at query execution — store as next last_synced_at',
  })
  serverTime: string;
}
