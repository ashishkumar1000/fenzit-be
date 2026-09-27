import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID, Validate } from 'class-validator';
import { AttendanceCalendarDateConstraint } from './attendance-date.validator';

/**
 * Enrolment DTOs (15-7). Dates are tenant-local `YYYY-MM-DD` keys (AD-7);
 * a past effective date is clamped to today by the service (AD-8 step 1 —
 * the `greatest()` clamp, never a 422). There is deliberately NO bulk
 * route: FR-2's "all employees" is an FE loop of the single-employee PUT
 * (user decision 2026-09-28).
 */
export class SetEnrolmentDto {
  @ApiProperty({
    description: 'Live office to enrol the employee with (FR-6: one office per tracked date).',
    example: '9f1c3e2a-1111-4c4c-8c8c-222233334444',
  })
  @IsUUID()
  officeId!: string;

  @ApiPropertyOptional({
    description:
      'Tracking start date (YYYY-MM-DD), default today. A future date enrols an upcoming employee (FR-2); a past date is clamped to today.',
    example: '2026-11-01',
  })
  @IsOptional()
  @Validate(AttendanceCalendarDateConstraint)
  startDate?: string;
}

/** PUT /attendance/enrolments/:employeeId/office — FR-6 reassignment. */
export class ReassignOfficeDto {
  @ApiProperty({
    description: 'The new office. Archived offices are refused (409).',
    example: '9f1c3e2a-1111-4c4c-8c8c-222233334444',
  })
  @IsUUID()
  officeId!: string;

  @ApiPropertyOptional({
    description:
      'Effective date (YYYY-MM-DD), default today. Must fall inside an enrolment (422 otherwise); applies from tomorrow automatically when the employee already checked in today (FR-6).',
    example: '2026-11-01',
  })
  @IsOptional()
  @Validate(AttendanceCalendarDateConstraint)
  effectiveFrom?: string;
}

/** DELETE /attendance/enrolments/:employeeId?effectiveFrom= */
export class EnrolmentQueryDto {
  @ApiPropertyOptional({
    description:
      'Disable effective from (YYYY-MM-DD), default today. Cancelling a future start removes the rows entirely; disabling an active employee clips both ranges and keeps history.',
    example: '2026-10-05',
  })
  @IsOptional()
  @Validate(AttendanceCalendarDateConstraint)
  effectiveFrom?: string;
}
