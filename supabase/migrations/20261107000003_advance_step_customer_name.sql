-- Owner step notices carry the customer's name when the job has one.
--
-- Why: the owner's push and bell read "Ravi is on the way" next to the job
-- number. A customer name makes the card recognisable at a glance ("Ravi is
-- on the way to Asha Traders"). The name is added to the notification payload
-- here (the DB owns the notification rows), and only when the customer has a
-- non-blank name — jsonb_strip_nulls drops the key otherwise, so the copy
-- layer falls back to the job-number wording.
--
-- Everything else is the function as it was in 20260913000002, the last full
-- definition (decision 36: every active company admin except the actor;
-- activity log; CAS on the step). 20260925000001 only revoked EXECUTE grants.
-- Checked against live prod: the body matched except for the customer lines.

CREATE OR REPLACE FUNCTION public.advance_workflow_step(p_job_id uuid, p_tenant_id uuid, p_actor_id uuid, p_step text, p_new_status text, p_expected_current_step text, p_latitude double precision DEFAULT NULL::double precision, p_longitude double precision DEFAULT NULL::double precision, p_accuracy double precision DEFAULT NULL::double precision, p_location_captured boolean DEFAULT NULL::boolean, p_reason text DEFAULT NULL::text, p_accuracy_flagged boolean DEFAULT NULL::boolean)
 RETURNS SETOF jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_job jobs%ROWTYPE;
  v_customer_name text;
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

  -- The customer's name, only when it is a real (non-blank) name. Tenant-
  -- scoped read: a customer from another tenant can never leak into a payload.
  SELECT NULLIF(btrim(c.name), '') INTO v_customer_name
  FROM customers c
  WHERE c.id = v_job.customer_id AND c.tenant_id = p_tenant_id;

  -- Notify every active company admin of the company (decision 36). Self-
  -- notification guard: an admin advancing their own job must not notify
  -- themselves.
  INSERT INTO notifications (tenant_id, user_id, job_id, event_type, payload)
  SELECT p_tenant_id,
         m.user_id,
         p_job_id,
         p_step,
         jsonb_strip_nulls(jsonb_build_object(
           'job_number', v_job.job_number,
           'step', p_step,
           'technician_name', COALESCE(NULLIF(u.name, ''), 'A technician'),
           'customer_name', v_customer_name
         ))
  FROM memberships m
  JOIN users au ON au.id = m.user_id
  LEFT JOIN users u ON u.id = p_actor_id
  WHERE m.tenant_id = p_tenant_id
    AND m.role = 'company_admin'
    AND m.status = 'active'
    AND NOT au.disabled
    AND m.user_id IS DISTINCT FROM p_actor_id;

  RETURN QUERY SELECT * FROM jobs WHERE id = p_job_id AND tenant_id = p_tenant_id;
END $function$;
