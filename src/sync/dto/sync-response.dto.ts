import { ApiProperty } from '@nestjs/swagger';
import {
  WorkflowStepResponse,
  WorkflowTemplateResponse,
} from '../../jobs/workflow-template.model';

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

/** The job's skill on a sync payload — id + display name (Story 4.5). */
export interface SyncSkill {
  id: string;
  name: string;
}

// Aliases to the model types (Story 4.5) — the sync payload carries exactly
// the job-response step/template shape, so the two cannot drift.
/** One template step on a sync payload — camelCase, like the job payloads. */
export type SyncWorkflowStep = WorkflowStepResponse;

/** The job's stamped workflow template on a sync payload (Story 4.5). */
export type SyncWorkflowTemplate = WorkflowTemplateResponse;

export interface SyncJobDto {
  id: string;
  jobNumber: string;
  tenantId: string;
  customerId: string;
  technicianId: string;
  serviceLocation: string;
  scheduledStart: string;
  scheduledEnd: string | null;
  status: string;
  currentStep: string | null;
  priority: string;
  description: string | null;
  notesForTechnician: string | null;
  createdAt: string;
  updatedAt: string;
  customer: SyncCustomer;
  attachments: AttachmentSummary[];
  // Story 4.5 — same skill/template shape the job responses carry, so the
  // technician's offline store renders the stepper without a detail fetch.
  skill: SyncSkill | null;
  workflowTemplate: SyncWorkflowTemplate | null;
  // 0-based index of current_step in the stamped steps; null while fresh.
  currentStepIndex: number | null;
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
