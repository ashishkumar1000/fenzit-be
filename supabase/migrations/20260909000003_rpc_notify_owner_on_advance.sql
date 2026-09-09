-- Story 3.1: notify the tenant owner on workflow advances.
-- Supersedes 20260903000003 (the latest live definition): identical body except
-- for the notifications INSERT added after the activity_logs INSERT, inside the
-- same transaction — a committed step advance produces exactly one notification
-- for tenants.owner_id; a rejected advance (PT409, not-found) produces zero.
-- Signature byte-identical (a signature change creates an overload — see
-- 20260905000004_drop_stale_rpc_overloads.sql for that mistake's cleanup).
-- An AFTER INSERT trigger on notifications (20260909000002) fans the row out
-- via realtime.broadcast_changes to user:<owner_id>:notifications.

CREATE OR REPLACE FUNCTION advance_workflow_step(
  p_job_id                UUID,
  p_tenant_id             UUID,
  p_actor_id              UUID,
  p_step                  TEXT,
  p_new_status            TEXT,
  p_expected_current_step TEXT
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
  INSERT INTO activity_logs (job_id, tenant_id, event_type, actor_id)
  VALUES (p_job_id, p_tenant_id, 'step_' || p_step, p_actor_id);

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
