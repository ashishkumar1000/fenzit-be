-- Story 7-3: Extend advance_workflow_step RPC to accept location parameters.
--
-- The RPC now accepts six optional location-related parameters that are merged
-- into the activity_logs metadata. No other RPC logic changes — the lock/guard/
-- status-update logic stays exactly as-is (per SPEC.md Constraints).
--
-- Parameters:
--   p_latitude, p_longitude, p_accuracy (location data)
--   p_location_captured (boolean indicating if location was captured)
--   p_reason (string explaining why location wasn't captured)
--   p_accuracy_flagged (boolean indicating low-accuracy flag)
--
-- Lat/long must arrive together or not at all — a partial pair is treated as
-- no coordinates, falling through to the location_captured-only branch.

CREATE OR REPLACE FUNCTION advance_workflow_step(
  p_job_id                UUID,           -- Job being advanced
  p_tenant_id             UUID,           -- Tenant isolation
  p_actor_id              UUID,           -- User performing advance (technician)
  p_step                  TEXT,           -- Step key being advanced to
  p_new_status            TEXT,           -- New job status ('in_progress', 'completed', or NULL to keep current)
  p_expected_current_step TEXT,           -- Current step value for compare-and-set (handles concurrent advances)
  p_latitude              DOUBLE PRECISION DEFAULT NULL,  -- Technician latitude (-90 to 90); must arrive with longitude or not at all
  p_longitude             DOUBLE PRECISION DEFAULT NULL,  -- Technician longitude (-180 to 180); must arrive with latitude or not at all
  p_accuracy              DOUBLE PRECISION DEFAULT NULL,  -- GPS accuracy in meters (>= 0); NULL if not applicable
  p_location_captured     BOOLEAN DEFAULT NULL,           -- Whether location was successfully captured (true/false/NULL if not applicable)
  p_reason                TEXT DEFAULT NULL,              -- Reason location wasn't captured (e.g., 'Location not provided', 'Location coordinates out of valid range')
  p_accuracy_flagged      BOOLEAN DEFAULT NULL            -- Flag indicating accuracy > 100m threshold (true if flagged, NULL otherwise)
)
RETURNS SETOF jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job jobs%ROWTYPE;
BEGIN
  -- Tenant-scoped row lock. A missing/cross-tenant row returns the empty set,
  -- which the app maps to 404 (cross-tenant is indistinguishable from not-found).
  SELECT * INTO v_job
  FROM jobs
  WHERE id = p_job_id AND tenant_id = p_tenant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- A finished/cancelled job cannot advance. Custom SQLSTATE the app maps to
  -- 409 JOB_NOT_MODIFIABLE (PTxxx convention: last 3 digits = HTTP status; the
  -- app reads error.code directly).
  IF v_job.status NOT IN ('scheduled', 'in_progress') THEN
    RAISE EXCEPTION 'job % not advanceable in status %', p_job_id, v_job.status
      USING ERRCODE = 'PT409';
  END IF;

  -- Compare-and-set: if current_step moved between the service's read and now
  -- (a concurrent advance / offline replay), reject the stale write. IS DISTINCT
  -- FROM is null-safe (the first on_my_way advance expects current_step = NULL).
  IF v_job.current_step IS DISTINCT FROM p_expected_current_step THEN
    RAISE EXCEPTION 'workflow step changed concurrently (expected %, found %)',
      p_expected_current_step, v_job.current_step
      USING ERRCODE = 'PT409';
  END IF;

  -- p_new_status is 'in_progress' for on_my_way, 'completed' for completed,
  -- else NULL (COALESCE leaves status unchanged at in_progress).
  UPDATE jobs
  SET current_step = p_step,
      status       = COALESCE(p_new_status, status),
      completed_at = CASE WHEN p_new_status = 'completed' THEN now() ELSE completed_at END,
      updated_at   = now()
  WHERE id = p_job_id;

  -- Every step appends an immutable activity-log entry (FR-11). tenant_id and
  -- actor_id are NOT NULL on activity_logs, so both must be supplied.
  -- Merge location data into metadata: lat/long must arrive together or not at all.
  INSERT INTO activity_logs (job_id, tenant_id, event_type, actor_id, metadata)
  VALUES (
    p_job_id, p_tenant_id, 'step_' || p_step, p_actor_id,
    CASE
      WHEN p_latitude IS NOT NULL AND p_longitude IS NOT NULL THEN
        jsonb_strip_nulls(jsonb_build_object(
          'latitude', p_latitude,
          'longitude', p_longitude,
          'accuracy', p_accuracy,
          'locationCaptured', p_location_captured,
          'reason', p_reason,
          'accuracyFlagged', p_accuracy_flagged
        ))
      WHEN p_location_captured IS NOT NULL THEN
        jsonb_strip_nulls(jsonb_build_object(
          'locationCaptured', p_location_captured,
          'reason', p_reason
        ))
      ELSE NULL
    END
  );

  -- Notify the tenant owner (Story 3.1). Self-notification guard: an owner
  -- advancing their own job must not notify themselves.
  INSERT INTO notifications (tenant_id, user_id, job_id, event_type, payload)
  SELECT p_tenant_id,
         t.owner_id,
         p_job_id,
         p_step,
         jsonb_build_object(
           'job_number', v_job.job_number,
           'step', p_step,
           'technician_name', COALESCE(NULLIF(u.name, ''), 'A technician')
         )
  FROM tenants t
  LEFT JOIN users u ON u.id = p_actor_id
  WHERE t.id = p_tenant_id
    AND t.owner_id <> p_actor_id;

  RETURN QUERY SELECT * FROM jobs WHERE id = p_job_id AND tenant_id = p_tenant_id;
END $$;
