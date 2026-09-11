import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
import { STEP_KEY_PATTERN } from '../workflow-template.model';

export class AdvanceWorkflowDto {
  @ApiProperty({
    pattern: '^[a-z0-9_]{1,64}$',
    description:
      'The workflow step to advance to. The FIRST not-yet-completed step in ' +
      'the job’s stamped template order is the only legal target: a fresh ' +
      'job (current_step null) advances to the template’s first step, ' +
      'every later advance to the next one. No skipping — the template’s ' +
      'ordered steps ARE the chain. A corrupt current_step (not present in the ' +
      'stamped template) rejects every advance.',
  })
  @IsString()
  @Matches(STEP_KEY_PATTERN)
  step: string;
}
