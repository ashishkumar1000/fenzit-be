-- RPC for atomic job edit/reassign/cancel (Story 3.4)
-- Called via the service-role client (createAdmin), so RLS is bypassed; the function
-- is tenant-scoped via the explicit p_tenant_id parameter. PostgREST runs the RPC in a
-- single transaction, so the job UPDATE and the activity_logs INSERT are atomic (AR-10).
--
-- The `scheduled`-only guard lives INSIDE the transaction (SELECT ... FOR UPDATE) to
-- close the TOCTOU window against a concurrent workflow-step advance (Story 3.5).
-- jobs.updated_at has no BEFORE UPDATE trigger, so every UPDATE sets it explicitly.

CREATE OR REPLACE FUNCTION update_job_with_log(
  p_job_id               UUID,
  p_tenant_id            UUID,
  p_actor_id             UUID,
  p_cancel               BOOLEAN,
  p_description          TEXT,
  p_scheduled_start      TIMESTAMPTZ,
  p_scheduled_end        TIMESTAMPTZ,
  p_notes_for_technician TEXT,
  p_technician_id        UUID,
  p_priority             TEXT
)
RETURNS SETOF jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job      jobs%ROWTYPE;
  v_old_tech UUID;
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

  -- Only a `scheduled` job is modifiable. Raise with a custom SQLSTATE the app
  -- maps to 409 JOB_NOT_MODIFIABLE. PT409 is in the PostgREST PTxxx convention
  -- (last 3 digits = HTTP status) but the app reads error.code directly.
  IF v_job.status <> 'scheduled' THEN
    RAISE EXCEPTION 'job % is not modifiable in status %', p_job_id, v_job.status
      USING ERRCODE = 'PT409';
  END IF;

  IF p_cancel THEN
    UPDATE jobs
    SET status = 'cancelled', updated_at = now()
    WHERE id = p_job_id;

    INSERT INTO activity_logs (job_id, tenant_id, event_type, actor_id)
    VALUES (p_job_id, p_tenant_id, 'job_cancelled', p_actor_id);
  ELSE
    v_old_tech := v_job.technician_id;

    -- Reject an inverted schedule window using the EFFECTIVE values (after the
    -- COALESCE patch), so a one-sided edit (only start, or only end) can't push
    -- the stored window past the unchanged bound. Mapped to 422 by the app.
    IF COALESCE(p_scheduled_end, v_job.scheduled_end) IS NOT NULL
       AND COALESCE(p_scheduled_end, v_job.scheduled_end)
         < COALESCE(p_scheduled_start, v_job.scheduled_start) THEN
      RAISE EXCEPTION 'scheduled_end before scheduled_start'
        USING ERRCODE = 'PT422';
    END IF;

    -- COALESCE: a NULL param leaves the column unchanged (PATCH semantics).
    -- Clearing a nullable field back to NULL is intentionally out of scope.
    UPDATE jobs
    SET description          = COALESCE(p_description, description),
        scheduled_start      = COALESCE(p_scheduled_start, scheduled_start),
        scheduled_end        = COALESCE(p_scheduled_end, scheduled_end),
        notes_for_technician = COALESCE(p_notes_for_technician, notes_for_technician),
        technician_id        = COALESCE(p_technician_id, technician_id),
        priority             = COALESCE(p_priority, priority),
        updated_at           = now()
    WHERE id = p_job_id;

    -- Reassignment log only when the technician actually changed. IS DISTINCT
    -- FROM is null-safe (the IS NOT NULL guard keeps an omitted technician from
    -- logging a spurious reassignment).
    IF p_technician_id IS NOT NULL AND p_technician_id IS DISTINCT FROM v_old_tech THEN
      INSERT INTO activity_logs (job_id, tenant_id, event_type, actor_id, metadata)
      VALUES (
        p_job_id, p_tenant_id, 'job_reassigned', p_actor_id,
        jsonb_build_object(
          'previousTechnicianId', v_old_tech,
          'newTechnicianId', p_technician_id
        )
      );
    END IF;
  END IF;

  RETURN QUERY SELECT * FROM jobs WHERE id = p_job_id AND tenant_id = p_tenant_id;
END $$;
