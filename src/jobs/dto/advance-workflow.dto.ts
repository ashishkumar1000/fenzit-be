import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { WorkflowStep } from '../enums/workflow-step.enum';

export class AdvanceWorkflowDto {
  @ApiProperty({
    enum: WorkflowStep,
    description:
      'The workflow step to advance to. The next REQUIRED step after the ' +
      'current one is the only legal target: photos_uploaded is required only ' +
      'when require_completion_photo is true, signature_captured only when ' +
      'require_completion_signature is true; on_my_way / arrived / in_progress / ' +
      'completed are always required. Flags are read fresh at each advance, so a ' +
      'step that was skipped (or whose requirement was switched off) is walked ' +
      'past when advancing onward.',
  })
  @IsEnum(WorkflowStep)
  step: WorkflowStep;
}
