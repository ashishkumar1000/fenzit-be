import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class JobSettingsDto {
  @ApiProperty({
    description: 'May this employee create their own jobs?',
  })
  @IsBoolean({ message: 'canCreateJobs must be true or false' })
  canCreateJobs: boolean;

  @ApiProperty({
    description:
      'Must the owner approve this employee\'s new jobs before they are assigned? Applies to new jobs only.',
  })
  @IsBoolean({ message: 'jobApprovalRequired must be true or false' })
  jobApprovalRequired: boolean;
}
