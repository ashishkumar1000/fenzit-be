-- Story 3.8: re-issue create_job_with_log with p_require_completion_signature.
-- Append-only history: never edit an applied migration. The new param is appended
-- at the END of the list (after p_year) — Postgres RPC params are positional, and
-- inserting mid-list would silently reorder existing positional callers. The
-- INSERT persists the flag with COALESCE(…, false), mirroring the photo flag.
-- increment_job_counter is NOT re-issued here (it is unchanged; separate function).

CREATE OR REPLACE FUNCTION create_job_with_log(
  p_tenant_id               UUID,
  p_customer_id             UUID,
  p_technician_id           UUID,
  p_service_location        TEXT,
  p_service_type            TEXT,
  p_scheduled_start         TIMESTAMPTZ,
  p_scheduled_end           TIMESTAMPTZ,
  p_description             TEXT,
  p_priority                TEXT,
  p_require_completion_photo BOOLEAN,
  p_notes_for_technician    TEXT,
  p_actor_id                UUID,
  p_year                    INT,
  p_require_completion_signature BOOLEAN
)
RETURNS SETOF jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_seq        INT;
  v_job_number TEXT;
  v_job_id     UUID := gen_random_uuid();
BEGIN
  v_seq := increment_job_counter(p_tenant_id, p_year);
  v_job_number := 'JB-' || p_year::text || '-' || lpad(v_seq::text, 4, '0');

  INSERT INTO jobs (
    id, tenant_id, job_number, customer_id, technician_id,
    service_location, service_type, scheduled_start, scheduled_end,
    status, current_step, priority, require_completion_photo,
    require_completion_signature,
    description, notes_for_technician
  ) VALUES (
    v_job_id, p_tenant_id, v_job_number, p_customer_id, p_technician_id,
    p_service_location, p_service_type, p_scheduled_start, p_scheduled_end,
    'scheduled', NULL, COALESCE(p_priority, 'normal'), COALESCE(p_require_completion_photo, false),
    COALESCE(p_require_completion_signature, false),
    p_description, p_notes_for_technician
  );

  INSERT INTO activity_logs (job_id, tenant_id, event_type, actor_id)
  VALUES (v_job_id, p_tenant_id, 'job_created', p_actor_id);

  RETURN QUERY SELECT * FROM jobs WHERE id = v_job_id;
END $$;
