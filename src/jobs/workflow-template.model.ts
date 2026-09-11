import { JobStatus } from './enums/job-status.enum';

/**
 * One step of a job's stamped workflow template — per-step behaviour is data
 * (Story 4.3), not code. The chain ORDER is positional: steps[i+1] is the
 * successor of steps[i]. Shape mirrors the DB validator
 * `workflow_steps_valid` (migration 20260911000003).
 */
export interface TemplateStep {
  key: string;
  label: string;
  requires_photo: boolean;
  requires_signature: boolean;
  sets_status: JobStatus.IN_PROGRESS | JobStatus.COMPLETED | null;
  advances_on: 'photo_confirm' | null;
}

/** Slug shape for step keys (mirrors the DB CHECK's pattern). */
export const STEP_KEY_PATTERN = /^[a-z0-9_]{1,64}$/;

const SETS_STATUS_VALUES: ReadonlySet<string> = new Set([
  'in_progress',
  'completed',
]);
const ADVANCES_ON_VALUES: ReadonlySet<string> = new Set(['photo_confirm']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlainBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

/** Parse a single step object; null when it violates the shape. */
function parseStep(raw: unknown): TemplateStep | null {
  if (!isRecord(raw)) return null;

  const key = raw['key'];
  if (typeof key !== 'string' || !STEP_KEY_PATTERN.test(key)) return null;

  const label = raw['label'];
  if (typeof label !== 'string' || label.trim().length === 0) return null;

  const {
    requires_photo: requiresPhoto,
    requires_signature: requiresSignature,
  } = raw;
  if (
    typeof requiresPhoto !== 'boolean' ||
    typeof requiresSignature !== 'boolean'
  ) {
    return null;
  }

  let setsStatus: TemplateStep['sets_status'] = null;
  if (raw['sets_status'] !== undefined && raw['sets_status'] !== null) {
    if (
      typeof raw['sets_status'] !== 'string' ||
      !SETS_STATUS_VALUES.has(raw['sets_status'])
    ) {
      return null;
    }
    setsStatus = raw['sets_status'] as TemplateStep['sets_status'];
  }

  let advancesOn: TemplateStep['advances_on'] = null;
  if (raw['advances_on'] !== undefined && raw['advances_on'] !== null) {
    if (
      typeof raw['advances_on'] !== 'string' ||
      !ADVANCES_ON_VALUES.has(raw['advances_on'])
    ) {
      return null;
    }
    advancesOn = raw['advances_on'] as TemplateStep['advances_on'];
  }

  return {
    key,
    label,
    requires_photo: requiresPhoto,
    requires_signature: requiresSignature,
    sets_status: setsStatus,
    advances_on: advancesOn,
  };
}

/**
 * Parse + validate a stamped template's steps JSONB. Returns null when the
 * row fails validation — a corrupt template blocks advances rather than
 * mis-driving the engine. The DB CHECK makes this unreachable for rows
 * written after migration 20260911000003; this is belt-and-braces.
 */
export function parseTemplateSteps(raw: unknown): TemplateStep[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const steps: TemplateStep[] = [];
  const keys = new Set<string>();
  for (const entry of raw) {
    const step = parseStep(entry);
    if (step === null || keys.has(step.key)) return null;
    keys.add(step.key);
    steps.push(step);
  }
  return steps;
}

/**
 * Index of `current` in the template order. -1 for a fresh job (null
 * current_step); null when current is a non-null value absent from the
 * template — the corrupt-data guard, which must reject every advance rather
 * than silently reset the workflow.
 */
export function indexOfCurrent(
  steps: TemplateStep[],
  current: string | null,
): number | null {
  if (current === null) return -1;
  const idx = steps.findIndex((s) => s.key === current);
  return idx === -1 ? null : idx;
}

/**
 * The only legal advance target: the first not-yet-completed step in template
 * order (steps[idx + 1]; steps[0] for a fresh job). Returns null when there is
 * no legal target (corrupt current_step, or the chain is exhausted).
 */
export function nextStepKey(
  steps: TemplateStep[],
  current: string | null,
): string | null {
  const idx = indexOfCurrent(steps, current);
  if (idx === null || idx + 1 >= steps.length) return null;
  return steps[idx + 1].key;
}

/** The target step's sets_status (null leaves the job's status unchanged). */
export function setsStatusOf(
  steps: TemplateStep[],
  key: string,
): JobStatus.IN_PROGRESS | JobStatus.COMPLETED | null {
  const step = steps.find((s) => s.key === key);
  return step ? step.sets_status : null;
}

/**
 * The step whose advances_on = 'photo_confirm', if the template has one —
 * the confirm-attachment auto-advance's target.
 */
export function photoConfirmStep(steps: TemplateStep[]): TemplateStep | null {
  return steps.find((s) => s.advances_on === 'photo_confirm') ?? null;
}

/**
 * One template step as exposed in job responses — camelCase (Story 4.5),
 * matching the rest of the job payloads. Values mirror TemplateStep 1:1.
 */
export interface WorkflowStepResponse {
  key: string;
  label: string;
  requiresPhoto: boolean;
  requiresSignature: boolean;
  setsStatus: TemplateStep['sets_status'];
  advancesOn: TemplateStep['advances_on'];
}

/** Story 4.5 — camelCase projection of a template step for API responses. */
export function stepToResponse(step: TemplateStep): WorkflowStepResponse {
  return {
    key: step.key,
    label: step.label,
    requiresPhoto: step.requires_photo,
    requiresSignature: step.requires_signature,
    setsStatus: step.sets_status,
    advancesOn: step.advances_on,
  };
}

/** The job's stamped workflow template — version + full ordered step chain. */
export interface WorkflowTemplateResponse {
  version: number;
  steps: WorkflowStepResponse[];
}

/**
 * PostgREST embeds a to-one related resource as an object, but can surface it
 * as an array — normalize both shapes. Shared by every skill-embed read
 * (job responses, customer job history, sync payload) so the call sites
 * cannot drift.
 */
export function normalizeSkillEmbed<T>(
  raw: T | T[] | null | undefined,
): T | null {
  if (Array.isArray(raw)) return raw[0] ?? null;
  return raw ?? null;
}

/**
 * Story 4.5 — currentStepIndex for READ surfaces: 0-based index of the job's
 * current step, null while the job is fresh (no advance yet) and null when the
 * step is corrupt (absent from the template). Deliberately softer than the
 * write path, where a corrupt current_step blocks every advance — reads never
 * fail on data the DB validator makes unreachable.
 */
export function currentStepIndexForRead(
  steps: TemplateStep[],
  current: string | null,
): number | null {
  const idx = indexOfCurrent(steps, current);
  return idx === -1 ? null : idx;
}
