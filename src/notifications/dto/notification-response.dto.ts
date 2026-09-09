import { ApiProperty } from '@nestjs/swagger';

/**
 * One owner notification. `payload` is the self-sufficient JSONB written by the
 * advance_workflow_step RPC (Story 3.1): { job_number, step, technician_name }.
 * It is returned verbatim — no read-time join to jobs/users.
 */
export class NotificationResponse {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  jobId: string;

  @ApiProperty({ description: 'Event type (the workflow step that fired it)' })
  eventType: string;

  @ApiProperty({ description: 'Self-sufficient event payload (JSONB)' })
  payload: Record<string, unknown>;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  readAt: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;
}
