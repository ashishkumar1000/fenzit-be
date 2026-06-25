-- RPCs for atomic job creation (Story 3.1)
-- Called via the service-role client (createAdmin), so RLS is bypassed; both functions
-- set tenant_id from the explicit p_tenant_id parameter. PostgREST runs each RPC in a
-- single transaction, and the nested increment_job_counter call shares it — counter
-- increment + job insert + activity_log insert are all atomic (AR-10).

-- Atomic, race-safe per-tenant/per-year counter. The ON CONFLICT upsert takes a row
-- lock, so concurrent callers serialize and produce strictly sequential, gap-free numbers.
CREATE OR REPLACE FUNCTION increment_job_counter(p_tenant_id UUID, p_year INT)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_seq INT;
BEGIN
  INSERT INTO job_sequences (tenant_id, year, last_seq)
  VALUES (p_tenant_id, p_year, 1)
  ON CONFLICT (tenant_id, year)
  DO UPDATE SET last_seq = job_sequences.last_seq + 1
  RETURNING last_seq INTO v_seq;
  RETURN v_seq;
END $$;

-- Atomic job insert + job_created activity log entry. Returns the created job row.
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
  p_year                    INT
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
    description, notes_for_technician
  ) VALUES (
    v_job_id, p_tenant_id, v_job_number, p_customer_id, p_technician_id,
    p_service_location, p_service_type, p_scheduled_start, p_scheduled_end,
    'scheduled', NULL, COALESCE(p_priority, 'normal'), COALESCE(p_require_completion_photo, false),
    p_description, p_notes_for_technician
  );

  INSERT INTO activity_logs (job_id, tenant_id, event_type, actor_id)
  VALUES (v_job_id, p_tenant_id, 'job_created', p_actor_id);

  RETURN QUERY SELECT * FROM jobs WHERE id = v_job_id;
END $$;
