-- Remove job-level location-capture toggle. Backend is now single source of truth (workflow template steps)
ALTER TABLE jobs DROP COLUMN IF EXISTS capture_location_on_steps;

-- Update RPC to remove the location capture toggle parameter
DROP FUNCTION IF EXISTS create_job_with_log(
  UUID, UUID, UUID, TEXT, UUID, TIMESTAMPTZ, TIMESTAMPTZ,
  TEXT, TEXT, TEXT, UUID, INT, BOOLEAN
);

CREATE FUNCTION create_job_with_log(
  p_tenant_id               UUID,
  p_customer_id             UUID,
  p_technician_id           UUID,
  p_service_location        TEXT,
  p_skill_id                UUID,
  p_scheduled_start         TIMESTAMPTZ,
  p_scheduled_end           TIMESTAMPTZ,
  p_description             TEXT,
  p_priority                TEXT,
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
  v_template_id      UUID;
  v_template_version INT;
BEGIN
  SELECT id, version
    INTO v_template_id, v_template_version
    FROM workflow_templates
   WHERE skill_id = p_skill_id
   ORDER BY version DESC
   LIMIT 1;

  IF v_template_id IS NULL THEN
    RAISE EXCEPTION 'No workflow template found for skill %', p_skill_id;
  END IF;

  v_seq := increment_job_counter(p_tenant_id, p_year);
  v_job_number := 'JB-' || p_year::text || '-' || lpad(v_seq::text, 4, '0');

  INSERT INTO jobs (
    id, tenant_id, job_number, customer_id, technician_id,
    service_location, skill_id, workflow_template_id,
    workflow_template_version, scheduled_start, scheduled_end,
    status, current_step, priority,
    description, notes_for_technician
  ) VALUES (
    v_job_id, p_tenant_id, v_job_number, p_customer_id, p_technician_id,
    p_service_location, p_skill_id, v_template_id,
    v_template_version, p_scheduled_start, p_scheduled_end,
    'scheduled', NULL, COALESCE(p_priority, 'normal'),
    p_description, p_notes_for_technician
  );

  INSERT INTO activity_logs (job_id, tenant_id, event_type, actor_id)
  VALUES (v_job_id, p_tenant_id, 'job_created', p_actor_id);

  RETURN QUERY SELECT * FROM jobs WHERE id = v_job_id;
END $$;
