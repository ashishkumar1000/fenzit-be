import { ApiProperty } from '@nestjs/swagger';

/**
 * One notification. `payload` is the self-sufficient JSONB written by the
 * advance_workflow_step RPC (Story 3.1): { job_number, step, technician_name }.
 * It is returned verbatim — no read-time join to jobs/users.
 *
 * `entityType`/`entityId` (Story 14.2, AD-13) are additive and nullable:
 * the polymorphic deep-link target for non-job events (attendance, leave…).
 * All current job/report inserts leave them NULL, so existing rows map to
 * null exactly as before.
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

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Polymorphic entity kind the event is about (e.g. attendance, leave) — null for job/report rows',
  })
  entityType: string | null;

  @ApiProperty({
    nullable: true,
    format: 'uuid',
    description: 'Polymorphic deep-link target id; null for job/report rows',
  })
  entityId: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;
}
