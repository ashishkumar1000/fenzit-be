import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

/**
 * FR-1 wizard step vocabulary — the fixed DB CHECK vocabulary in
 * attendance_setup_progress, mirrored here so an unknown step is a 422 from
 * the ValidationPipe before it ever reaches the service. Holidays is the
 * only skippable step; skipping is the FE's concern, the marker just moves.
 */
export const SETUP_STEPS = [
  'offices',
  'timings',
  'weekly_off',
  'holidays',
  'employees',
] as const;

export type SetupStep = (typeof SETUP_STEPS)[number];

export class UpdateSetupStepDto {
  @ApiProperty({
    enum: SETUP_STEPS,
    description: 'The wizard step the owner is now on.',
  })
  @IsIn(SETUP_STEPS as unknown as string[])
  currentStep: SetupStep;
}