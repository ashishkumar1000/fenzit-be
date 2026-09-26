import type { SetupStep } from './dto/update-setup-step.dto';

/** attendance_settings row (snake_case, DB shape). */
export interface AttendanceSettingsRow {
  tenant_id: string;
  enabled: boolean;
  setup_completed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** attendance_setup_progress row (snake_case, DB shape). */
export interface AttendanceSetupProgressRow {
  tenant_id: string;
  current_step: string;
  created_at: string;
  updated_at: string;
}

/**
 * GET /attendance/setup — resume state for the FR-1 wizard. started=false
 * until the owner calls POST /attendance/setup; before that there is no
 * settings row at all (rows are created on demand).
 */
export interface SetupStateResponse {
  started: boolean;
  currentStep: SetupStep | null;
  setupCompletedAt: string | null;
  enabled: boolean;
}

export function toSetupStateResponse(
  settings: AttendanceSettingsRow | null,
  progress: AttendanceSetupProgressRow | null,
): SetupStateResponse {
  return {
    started: settings !== null,
    currentStep: progress ? (progress.current_step as SetupStep) : null,
    setupCompletedAt: settings?.setup_completed_at ?? null,
    enabled: settings?.enabled ?? false,
  };
}