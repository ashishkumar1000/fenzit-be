import { ApiPropertyOptional, PartialType, PickType } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { CreateJobDto } from './create-job.dto';
import { JobStatus } from '../enums/job-status.enum';

/**
 * Body for `PATCH /api/v1/jobs/:id` (Story 3.4, extended by epic 22 / CAP-5).
 *
 * The mutable fields are `PickType`d from CreateJobDto (reusing its
 * validators/transformers) so the owner can edit everything the creator could
 * set: description, times, notes, technician, priority — and, since epic 22,
 * the service location, the skill and the customer. `newCustomer` stays
 * immutable (an inline find-or-create belongs to the create flow only). The
 * Story 3.8 completion flags are gone (Story 4.4): per-step photo/signature
 * behaviour lives in the job's stamped workflow template now. `PartialType`
 * makes the fields all optional. The cancellation-only `status` is added on
 * top; lifecycle transitions to in_progress/completed are the workflow
 * endpoint's job (Story 3.5), so `status` here may only be `cancelled`.
 */
export class UpdateJobDto extends PartialType(
  PickType(CreateJobDto, [
    'description',
    'scheduledStart',
    'scheduledEnd',
    'notesForTechnician',
    'technicianId',
    'priority',
    'serviceLocation',
    'skillId',
    'customerId',
  ] as const),
) {
  @ApiPropertyOptional({
    enum: [JobStatus.CANCELLED],
    description:
      'Set to "cancelled" to cancel a scheduled job. No other value is accepted.',
  })
  @IsOptional()
  @IsIn([JobStatus.CANCELLED])
  status?: JobStatus.CANCELLED;
}
