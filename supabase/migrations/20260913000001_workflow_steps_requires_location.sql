-- Story 7-2: Extend workflow steps schema to support per-step requires_location.
--
-- The workflow step schema now supports an optional requires_location boolean
-- per step, defaulting to true if absent. This allows per-step location
-- configuration (CAP-3) while the MVP frontend exposes only the job-level
-- toggle (CAP-1).
--
-- The CHECK function and TypeScript parseStep() mirror must be updated in the
-- same commit or they silently drift.

-- Drop the existing constraint and function so we can update it
ALTER TABLE workflow_templates
  DROP CONSTRAINT IF EXISTS workflow_templates_steps_shape;

-- Replace the workflow_steps_valid function with one that accepts requires_location
CREATE OR REPLACE FUNCTION workflow_steps_valid(p_steps JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_step  JSONB;
  v_i     INT;
  v_n     INT;
  v_keys  TEXT[];
  v_key   TEXT;
BEGIN
  IF p_steps IS NULL OR jsonb_typeof(p_steps) <> 'array'
     OR jsonb_array_length(p_steps) = 0 THEN
    RETURN FALSE;
  END IF;

  v_n := jsonb_array_length(p_steps);

  FOR v_i IN 0 .. v_n - 1 LOOP
    v_step := p_steps -> v_i;

    IF jsonb_typeof(v_step) <> 'object' THEN
      RETURN FALSE;
    END IF;

    v_key := v_step ->> 'key';
    IF v_key IS NULL OR v_key !~ '^[a-z0-9_]{1,64}$' THEN
      RETURN FALSE;
    END IF;
    IF v_key = ANY (v_keys) THEN
      RETURN FALSE;
    END IF;
    v_keys := array_append(v_keys, v_key);

    IF v_step ->> 'label' IS NULL OR btrim(v_step ->> 'label') = '' THEN
      RETURN FALSE;
    END IF;

    IF jsonb_typeof(v_step -> 'requires_photo') <> 'boolean'
       OR jsonb_typeof(v_step -> 'requires_signature') <> 'boolean' THEN
      RETURN FALSE;
    END IF;

    -- requires_location is optional; if present, must be boolean
    IF v_step ? 'requires_location'
       AND jsonb_typeof(v_step -> 'requires_location') <> 'boolean' THEN
      RETURN FALSE;
    END IF;

    IF v_step ? 'sets_status'
       AND jsonb_typeof(v_step -> 'sets_status') <> 'null'
       AND v_step ->> 'sets_status' NOT IN ('in_progress', 'completed') THEN
      RETURN FALSE;
    END IF;

    IF v_step ? 'advances_on'
       AND jsonb_typeof(v_step -> 'advances_on') <> 'null'
       AND v_step ->> 'advances_on' NOT IN ('photo_confirm') THEN
      RETURN FALSE;
    END IF;
  END LOOP;

  RETURN TRUE;
END $$;

-- Re-add the constraint
ALTER TABLE workflow_templates
  ADD CONSTRAINT workflow_templates_steps_shape
  CHECK (workflow_steps_valid(steps));
