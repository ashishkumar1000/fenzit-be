-- Story 4.3: workflow templates + skill-tagged jobs
--
-- A job's "what kind of work" identity moves from the service_type CHECK enum
-- (whose values never matched the skills catalog) to a skill tag plus a
-- workflow template stamp:
--
--   1) Test-data reset (unconditional) — TRUNCATE jobs CASCADE.
--   2) workflow_templates table (skill_id + version, steps JSONB) + RLS.
--   3) Seed one v1 template per skill (fixed UUIDs, identical 6-step chain).
--   4) jobs: add skill_id / workflow_template_id / workflow_template_version,
--      drop service_type + its CHECK.
--   5) Drop the 14-param create_job_with_log and re-issue it with p_skill_id
--      (CREATE OR REPLACE would create a new overload, not replace — precedent
--      20260905000004_drop_stale_rpc_overloads.sql).
--
-- Advance engine untouched (advance_workflow_step / STEP_ORDER — Story 4.4).
-- Skills seed UUIDs are Story 4.1's and must never change; the template seed
-- UUIDs here are fixed the same way (Story 4.4/4.5 reference them).

-- 1) Test-data reset. The TRUNCATE below is unconditional by design — it
--    deliberately wipes test job rows in EVERY environment (plus their
--    activity_logs, attachments, attachment_uploads, notifications). There is
--    no conditional guard to reason about; this is the pre-launch clean
--    cutover that makes the NOT NULL column adds below need no backfill.
--    No backfill, no shim.
TRUNCATE jobs CASCADE;

-- 2) workflow_templates: one row per (skill, version). Steps is the canonical
--    per-step data (key, label, requires_photo, requires_signature,
--    sets_status, advances_on) the engine later reads (Story 4.4). Created via
--    migration seeds only — no API write path, like skills.
CREATE TABLE workflow_templates (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id   UUID        NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
  version    INT         NOT NULL,
  steps      JSONB       NOT NULL CHECK (jsonb_typeof(steps) = 'array'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (skill_id, version)
);

ALTER TABLE workflow_templates ENABLE ROW LEVEL SECURITY;

-- Global reference data (mirrors skills_authenticated_read): any authenticated
-- user can read; writes are denied via RLS — no write policy exists.
CREATE POLICY workflow_templates_authenticated_read ON workflow_templates
  FOR SELECT TO authenticated
  USING (true);

-- 3) Seed v1: one template per skill, all six the identical chain that
--    mirrors today's hardcoded STEP_ORDER (labels are new — today only the FE
--    hardcodes them; these become the canonical label source). advances_on
--    "photo_confirm" on photos_uploaded encodes today's confirm-attachment
--    auto-advance for Story 4.4 to read. Fixed template UUIDs — later
--    migrations may reference them, so they must never change.
WITH v1_steps AS (
  SELECT '[
    {"key": "on_my_way", "label": "On My Way", "requires_photo": false, "requires_signature": false, "sets_status": "in_progress", "advances_on": null},
    {"key": "arrived", "label": "Arrived", "requires_photo": false, "requires_signature": false, "sets_status": null, "advances_on": null},
    {"key": "in_progress", "label": "In Progress", "requires_photo": false, "requires_signature": false, "sets_status": null, "advances_on": null},
    {"key": "photos_uploaded", "label": "Photos Uploaded", "requires_photo": true, "requires_signature": false, "sets_status": null, "advances_on": "photo_confirm"},
    {"key": "signature_captured", "label": "Signature Captured", "requires_photo": false, "requires_signature": true, "sets_status": null, "advances_on": null},
    {"key": "completed", "label": "Completed", "requires_photo": false, "requires_signature": false, "sets_status": "completed", "advances_on": null}
  ]'::jsonb AS steps
)
INSERT INTO workflow_templates (id, skill_id, version, steps)
SELECT '6f1a2b3c-4d5e-4f6a-8b7c-1d2e3f4a5b6c'::uuid,
       'd89d67f7-c0fe-42f8-9f76-c1660c98ce97'::uuid, 1, steps FROM v1_steps
UNION ALL
SELECT '7f2b3c4d-5e6f-4a7b-8c8d-2e3f4a5b6c7d'::uuid,
       '77d9450a-f9a4-4992-a82a-cdf27063e9e9'::uuid, 1, steps FROM v1_steps
UNION ALL
SELECT '8a3c4d5e-6f7a-4b8c-9d9e-3f4a5b6c7d8e'::uuid,
       '65f33480-b37e-47e2-a4a0-0155b156cc7a'::uuid, 1, steps FROM v1_steps
UNION ALL
SELECT '9b4d5e6f-7a8b-4c9d-8e8f-4a5b6c7d8e9f'::uuid,
       '95f021b0-a973-45fc-b73f-db0dc5afd4a0'::uuid, 1, steps FROM v1_steps
UNION ALL
SELECT 'ac5e6f7a-8b9c-4dae-8f9a-5b6c7d8e9f0a'::uuid,
       '71cc840c-3663-489e-bbf2-867d92c46619'::uuid, 1, steps FROM v1_steps
UNION ALL
SELECT 'bd6f7a8b-9cad-4ebf-8aab-6c7d8e9f0a1b'::uuid,
       '72f67596-fec7-4ae8-a6f1-fceabaef0d7d'::uuid, 1, steps FROM v1_steps;

-- 4) jobs: skill tag + template stamp replace service_type. Both FKs RESTRICT —
--    skills/templates are never API-deleted, so an accidental deletion must
--    fail loudly. The stamp is written only by the RPC at insert; no create/
--    PATCH code path writes it again.
ALTER TABLE jobs
  ADD COLUMN skill_id UUID NOT NULL
    REFERENCES skills(id) ON DELETE RESTRICT,
  ADD COLUMN workflow_template_id UUID NOT NULL
    REFERENCES workflow_templates(id) ON DELETE RESTRICT,
  ADD COLUMN workflow_template_version INT NOT NULL,
  DROP COLUMN service_type,
  DROP CONSTRAINT IF EXISTS jobs_service_type_check;

-- 5) Re-issue create_job_with_log with p_skill_id (drops the 14-param
--    overload). The stamp is resolved INSIDE the RPC — latest version for the
--    skill — so the app can never write it again. A skill without a template
--    raises (the v1 seed above makes this unreachable).
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
  p_year integer,
  p_require_completion_signature boolean
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
    -- The v1 seed guarantees a template per skill; reaching this is a server
    -- fault (a plain failure, not a new error contract).
    RAISE EXCEPTION 'No workflow template found for skill %', p_skill_id;
  END IF;

  v_seq := increment_job_counter(p_tenant_id, p_year);
  v_job_number := 'JB-' || p_year::text || '-' || lpad(v_seq::text, 4, '0');

  INSERT INTO jobs (
    id, tenant_id, job_number, customer_id, technician_id,
    service_location, skill_id, workflow_template_id,
    workflow_template_version, scheduled_start, scheduled_end,
    status, current_step, priority, require_completion_photo,
    require_completion_signature,
    description, notes_for_technician
  ) VALUES (
    v_job_id, p_tenant_id, v_job_number, p_customer_id, p_technician_id,
    p_service_location, p_skill_id, v_template_id,
    v_template_version, p_scheduled_start, p_scheduled_end,
    'scheduled', NULL, COALESCE(p_priority, 'normal'),
    COALESCE(p_require_completion_photo, false),
    COALESCE(p_require_completion_signature, false),
    p_description, p_notes_for_technician
  );

  INSERT INTO activity_logs (job_id, tenant_id, event_type, actor_id)
  VALUES (v_job_id, p_tenant_id, 'job_created', p_actor_id);

  RETURN QUERY SELECT * FROM jobs WHERE id = v_job_id;
END $$;
