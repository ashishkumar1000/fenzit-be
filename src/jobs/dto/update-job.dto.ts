import { ApiPropertyOptional, PartialType, PickType } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { CreateJobDto } from './create-job.dto';
import { JobStatus } from '../enums/job-status.enum';

/**
 * Body for `PATCH /api/v1/jobs/:id` (Story 3.4).
 *
 * Only the FR-9 mutable fields are exposed — we `PickType` the mutable subset of
 * CreateJobDto (reusing its validators/transformers) rather than `OmitType`, which
 * would leak the immutable serviceLocation/serviceType/customerId/newCustomer.
 * `PartialType` makes them all optional. The cancellation-only `status` is added
 * on top; lifecycle transitions to in_progress/completed are the workflow
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
