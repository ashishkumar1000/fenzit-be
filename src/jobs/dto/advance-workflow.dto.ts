import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { WorkflowStep } from '../enums/workflow-step.enum';

export class AdvanceWorkflowDto {
  @ApiProperty({
    enum: WorkflowStep,
    description:
      'The workflow step to advance to. Must be the immediate successor of the ' +
      "job's current step (photos_uploaded is skippable when " +
      'require_completion_photo is false).',
  })
  @IsEnum(WorkflowStep)
  step: WorkflowStep;
}
