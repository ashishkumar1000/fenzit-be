import { ApiProperty, ApiPropertyOptional } from ‘@nestjs/swagger’;
import { IsString, Matches, IsNumber, IsOptional, Min, Max } from ‘class-validator’;
import { STEP_KEY_PATTERN } from ‘../workflow-template.model’;

export class AdvanceWorkflowDto {
  @ApiProperty({
    pattern: ‘^[a-z0-9_]{1,64}$’,
    description:
      ‘The workflow step to advance to. The FIRST not-yet-completed step in ‘ +
      ‘the job’s stamped template order is the only legal target: a fresh ‘ +
      ‘job (current_step null) advances to the template’s first step, ‘ +
      ‘every later advance to the next one. No skipping — the template’s ‘ +
      ‘ordered steps ARE the chain. A corrupt current_step (not present in the ‘ +
      ‘stamped template) rejects every advance.’,
  })
  @IsString()
  @Matches(STEP_KEY_PATTERN)
  step: string;

  @ApiPropertyOptional({
    type: ‘number’,
    description: ‘Latitude of the technician when completing the step (optional). ‘ +
      ‘Required if step requires location and location was captured. Must be between -90 and 90.’,
  })
  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude?: number;

  @ApiPropertyOptional({
    type: ‘number’,
    description: ‘Longitude of the technician when completing the step (optional). ‘ +
      ‘Required if step requires location and location was captured. Must be between -180 and 180.’,
  })
  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude?: number;

  @ApiPropertyOptional({
    type: ‘number’,
    description: ‘Accuracy of the GPS location in meters (optional). ‘ +
      ‘Values > 100m are flagged but do not block step advancement.’,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  accuracy?: number;
}
