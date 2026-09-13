-- Drop stale overloads of advance_workflow_step.
-- CREATE OR REPLACE with changed param lists creates new overloads rather than replacing.
-- The original 6-param signature is now ambiguous with the 12-param (with defaults) version.
-- Keep only the latest 12-param version with location support.

DROP FUNCTION IF EXISTS advance_workflow_step(
  p_job_id uuid,
  p_tenant_id uuid,
  p_actor_id uuid,
  p_step text,
  p_new_status text,
  p_expected_current_step text
);

DROP FUNCTION IF EXISTS advance_workflow_step(
  p_job_id uuid,
  p_tenant_id uuid,
  p_actor_id uuid,
  p_step text,
  p_new_status text,
  p_expected_current_step text,
  p_completed_at timestamptz
);

DROP FUNCTION IF EXISTS advance_workflow_step(
  p_job_id uuid,
  p_tenant_id uuid,
  p_actor_id uuid,
  p_step text,
  p_new_status text,
  p_expected_current_step text,
  p_completed_at timestamptz,
  p_notify_owner boolean
);
