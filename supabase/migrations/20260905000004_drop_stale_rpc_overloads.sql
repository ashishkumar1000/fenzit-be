-- Story 3.8 review follow-up: drop the stale pre-3.8 RPC overloads.
-- CREATE OR REPLACE with a changed param list creates a NEW overload rather than
-- replacing, so the legacy 13-param create_job_with_log and 10-param
-- update_job_with_log remained callable (and PostgREST-exposed) alongside the
-- re-issued versions. No caller uses them (the app sends the full named param
-- set); dropping keeps exactly one live signature per RPC. Append-only history:
-- this runs AFTER 20260905000002/3 created the new overloads.
-- Accepted: development phase — all data is test data.

DROP FUNCTION IF EXISTS create_job_with_log(
  p_tenant_id uuid,
  p_customer_id uuid,
  p_technician_id uuid,
  p_service_location text,
  p_service_type text,
  p_scheduled_start timestamptz,
  p_scheduled_end timestamptz,
  p_description text,
  p_priority text,
  p_require_completion_photo boolean,
  p_notes_for_technician text,
  p_actor_id uuid,
  p_year integer
);

DROP FUNCTION IF EXISTS update_job_with_log(
  p_job_id uuid,
  p_tenant_id uuid,
  p_actor_id uuid,
  p_cancel boolean,
  p_description text,
  p_scheduled_start timestamptz,
  p_scheduled_end timestamptz,
  p_notes_for_technician text,
  p_technician_id uuid,
  p_priority text
);
