-- RPC for atomic technician workflow-step advancement (Story 3.5)
-- Called via the service-role client (createAdmin), so RLS is bypassed; the function
-- is tenant-scoped via the explicit p_tenant_id parameter. PostgREST runs the RPC in a
-- single transaction, so the job UPDATE and the activity_logs INSERT are atomic (AR-10).
--
-- Step-ORDERING is validated in WorkflowService (the friendly 422 + currentStep body).
-- This RPC owns the AUTHORITATIVE, TOCTOU-safe guards inside SELECT ... FOR UPDATE:
--   1. terminal status (completed/cancelled) -> PT409
--   2. compare-and-set: the locked row's current_step must still equal the value the
--      service read (p_expected_current_step), else a concurrent advance won -> PT409
-- jobs.updated_at has no BEFORE UPDATE trigger, so the UPDATE sets it explicitly.

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
      updated_at   = now()
  WHERE id = p_job_id;

  -- Every step appends an immutable activity-log entry (FR-11). tenant_id and
  -- actor_id are NOT NULL on activity_logs, so both must be supplied.
  INSERT INTO activity_logs (job_id, tenant_id, event_type, actor_id)
  VALUES (p_job_id, p_tenant_id, 'step_' || p_step, p_actor_id);

  RETURN QUERY SELECT * FROM jobs WHERE id = p_job_id AND tenant_id = p_tenant_id;
END $$;
