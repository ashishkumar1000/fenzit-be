-- Story 4.4: generic workflow engine + attachment auto-advance.
--
-- The advance engine stops being a hardcoded 6-step chain and starts reading
-- the workflow template stamped on the job (Story 4.3). This migration:
--
--   1) workflow_steps_valid() — per-step shape validation for
--      workflow_templates.steps (closes the Story 4.3 deferred item), wired as
--      a CHECK so a malformed template row fails at write time, not at advance.
--   2) Drop the job-level require_completion_photo / require_completion_signature
--      columns — per-step behaviour lives in the template steps now.
--   3) Re-issue create_job_with_log without its flag params (DROP + CREATE —
--      a signature change via CREATE OR REPLACE would create an overload,
--      precedent 20260905000004_drop_stale_rpc_overloads.sql).
--   4) Re-issue update_job_with_log without its flag params (same reason).
--   5) Re-issue confirm_attachment: the first-photo auto-advance no longer
--      hard-codes in_progress → photos_uploaded. It reads the stamped
--      template, finds the step whose advances_on = 'photo_confirm', and —
--      when the just-confirmed photo is the job's first AND current_step is
--      that step's immediate template predecessor — delegates to
--      advance_workflow_step, which brings the activity-log write, the owner
--      notification (with the self-notify guard), the compare-and-set guard,
--      and the completed_at stamping along unchanged. A PT409 from the
--      delegated advance (terminal job, or a concurrent advance moved
--      current_step) is logged and swallowed — the attachment insert itself
--      must still succeed.
--
-- advance_workflow_step itself is NOT modified: it is already generic (it takes
-- p_step + p_new_status from the app and does no step-sequence reasoning of
-- its own). Skills/template seed UUIDs (20260910000001 / 20260911000002) are
-- untouched.

-- 1) Steps shape validator. IMMUTABLE so it can live in a CHECK constraint.
--    Enforces, for every element: an object with a slug-shaped non-empty key
--    (unique across the array), a non-empty label, boolean requires_photo /
--    requires_signature, and sets_status / advances_on either absent, JSON
--    null, or one of their permitted values. The chain ORDER is positional —
--    the engine reads steps[i+1] as the successor of steps[i].
CREATE FUNCTION workflow_steps_valid(p_steps JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_step  JSONB;
  v_i     INT;
  v_n     INT;
  v_keys  TEXT[];
  v_key   TEXT;
BEGIN
  IF p_steps IS NULL OR jsonb_typeof(p_steps) <> 'array'
     OR jsonb_array_length(p_steps) = 0 THEN
    RETURN FALSE;
  END IF;

  v_n := jsonb_array_length(p_steps);

  FOR v_i IN 0 .. v_n - 1 LOOP
    v_step := p_steps -> v_i;

    IF jsonb_typeof(v_step) <> 'object' THEN
      RETURN FALSE;
    END IF;

    v_key := v_step ->> 'key';
    IF v_key IS NULL OR v_key !~ '^[a-z0-9_]{1,64}$' THEN
      RETURN FALSE;
    END IF;
    IF v_key = ANY (v_keys) THEN
      RETURN FALSE;
    END IF;
    v_keys := array_append(v_keys, v_key);

    IF v_step ->> 'label' IS NULL OR btrim(v_step ->> 'label') = '' THEN
      RETURN FALSE;
    END IF;

    IF jsonb_typeof(v_step -> 'requires_photo') <> 'boolean'
       OR jsonb_typeof(v_step -> 'requires_signature') <> 'boolean' THEN
      RETURN FALSE;
    END IF;

    IF v_step ? 'sets_status'
       AND jsonb_typeof(v_step -> 'sets_status') <> 'null'
       AND v_step ->> 'sets_status' NOT IN ('in_progress', 'completed') THEN
      RETURN FALSE;
    END IF;

    IF v_step ? 'advances_on'
       AND jsonb_typeof(v_step -> 'advances_on') <> 'null'
       AND v_step ->> 'advances_on' NOT IN ('photo_confirm') THEN
      RETURN FALSE;
    END IF;
  END LOOP;

  RETURN TRUE;
END $$;

ALTER TABLE workflow_templates
  ADD CONSTRAINT workflow_templates_steps_shape
  CHECK (workflow_steps_valid(steps));

-- 2) The job-level flags are gone — a template's requires_photo /
--    requires_signature step attributes carry the per-step behaviour.
ALTER TABLE jobs
  DROP COLUMN require_completion_photo,
  DROP COLUMN require_completion_signature;

-- 3) create_job_with_log: same body as 20260911000002 minus the two flag
--    params and their COALESCE writes.
DROP FUNCTION IF EXISTS create_job_with_log(
  p_tenant_id uuid,
  p_customer_id uuid,
  p_technician_id uuid,
  p_service_location text,
  p_skill_id uuid,
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

-- 4) update_job_with_log: same body as 20260905000003 minus the flag params
--    and their COALESCE writes.
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
  p_priority text,
  p_require_completion_photo boolean,
  p_require_completion_signature boolean
);

CREATE FUNCTION update_job_with_log(
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

-- 5) confirm_attachment: template-driven first-photo auto-advance. Steps 1-5
--    are copied verbatim from 20260621000014 (the current live definition) —
--    only section 6 changes.
CREATE OR REPLACE FUNCTION confirm_attachment(
  p_upload_id  UUID,
  p_job_id     UUID,
  p_tenant_id  UUID,
  p_size_bytes INT,
  p_actor_id   UUID  -- NULL for Worker/system calls
)
RETURNS TABLE (
  attachment_id   UUID,
  attachment_type TEXT,
  created_at      TIMESTAMPTZ,
  already_existed BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_upload      attachment_uploads%ROWTYPE;
  v_att_id      UUID;
  v_created_at  TIMESTAMPTZ;
  v_photo_count BIGINT;
  v_existing_id UUID;  -- upload_id of the row being replaced (for conflict log)
  v_steps       JSONB;  -- the job's stamped template steps
  v_i           INT;
  v_n           INT;
  v_photo_idx   INT;    -- index of the advances_on='photo_confirm' step
  v_photo_key   TEXT;   -- that step's key (auto-advance target)
  v_prev_key    TEXT;   -- its immediate template predecessor (compare-and-set)
  v_sets_status TEXT;   -- that step's sets_status (may be NULL)
  v_current     TEXT;   -- the job's current_step at confirm time
BEGIN
  -- 1. Fetch and lock staging row (tenant-scoped)
  SELECT * INTO v_upload
  FROM attachment_uploads
  WHERE id = p_upload_id
    AND job_id = p_job_id
    AND tenant_id = p_tenant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'UPLOAD_NOT_FOUND';
  END IF;

  -- 2. Idempotent: this exact upload was already confirmed — return the existing
  --    attachments row. No data is replaced (same upload_id, same R2 key), so this
  --    is a duplicate delivery, NOT a conflict — no conflict_resolved log.
  IF v_upload.status = 'confirmed' THEN
    SELECT a.id, a.created_at
      INTO v_att_id, v_created_at
      FROM attachments a
      WHERE a.upload_id = p_upload_id;

    RETURN QUERY SELECT v_att_id, v_upload.attachment_type, v_created_at, TRUE;
    RETURN;
  END IF;

  -- 3. Expired (AC#8)
  IF v_upload.expires_at < now() THEN
    UPDATE attachment_uploads SET status = 'expired' WHERE id = p_upload_id;
    RAISE EXCEPTION 'UPLOAD_EXPIRED';
  END IF;

  -- 4. Insert/upsert into attachments
  IF v_upload.attachment_type = 'signature' THEN
    -- Signature upsert: replace existing signature for this job (AC#7).
    -- Capture the existing upload_id so we can reference it in the conflict log.
    SELECT att.upload_id INTO v_existing_id
      FROM attachments att
      WHERE att.job_id = p_job_id
        AND att.tenant_id = p_tenant_id
        AND att.attachment_type = 'signature';

    UPDATE attachments att
      SET r2_key     = v_upload.r2_key,
          upload_id  = p_upload_id,
          size_bytes = p_size_bytes,
          created_at = now()
      WHERE att.job_id = p_job_id
        AND att.tenant_id = p_tenant_id
        AND att.attachment_type = 'signature'
      RETURNING att.id INTO v_att_id;

    IF FOUND THEN
      -- A distinct prior upload was replaced → last-write-wins conflict. FOUND is
      -- true only when the UPDATE matched the row the SELECT above captured, so
      -- v_existing_id is non-NULL here.
      INSERT INTO activity_logs (job_id, tenant_id, event_type, actor_id, metadata)
        VALUES (
          p_job_id, p_tenant_id, 'conflict_resolved', p_actor_id,
          jsonb_build_object(
            'reason',              'last_write_wins',
            'replaced_upload_id',  v_existing_id::text
          )
        );
    ELSE
      -- No existing signature row: INSERT. Under genuine concurrency, two
      -- confirms (DIFFERENT uploads) can both reach NOT FOUND and both attempt the
      -- INSERT; the loser raises unique_violation (23505) against the partial
      -- unique index uniq_attachments_signature_per_job (migration 010). The
      -- winner's row already satisfies AC#7 — resolve idempotently AND record
      -- the conflict instead of letting 23505 bubble to a 500 / Worker
      -- poison-retry.
      BEGIN
        INSERT INTO attachments (job_id, tenant_id, upload_id, r2_key, attachment_type, size_bytes)
          VALUES (p_job_id, p_tenant_id, p_upload_id, v_upload.r2_key, 'signature', p_size_bytes)
          RETURNING id INTO v_att_id;
      EXCEPTION WHEN unique_violation THEN
        SELECT a.id, a.upload_id INTO v_att_id, v_existing_id
          FROM attachments a
          WHERE a.job_id = p_job_id
            AND a.tenant_id = p_tenant_id
            AND a.attachment_type = 'signature';

        -- The winning concurrent upload (v_existing_id) is the one that survives;
        -- this confirm lost the race for the slot. Log the conflict so the
        -- discarded upload (p_upload_id) is traceable.
        INSERT INTO activity_logs (job_id, tenant_id, event_type, actor_id, metadata)
          VALUES (
            p_job_id, p_tenant_id, 'conflict_resolved', p_actor_id,
            jsonb_build_object(
              'reason',               'last_write_wins',
              'replaced_upload_id',   p_upload_id::text,
              'winning_upload_id',    v_existing_id::text
            )
          );
      END;
    END IF;

    SELECT a.created_at INTO v_created_at FROM attachments a WHERE a.id = v_att_id;
  ELSE
    -- Hard-enforce the 5-photo cap at confirm time (AC#4). The request-time
    -- check in AttachmentsService is a check-then-act read and is racy: N
    -- parallel requests all see count < 5 and mint presigned URLs. This count
    -- runs while the staging row is held under FOR UPDATE, but note photos are
    -- separate staging rows — the authoritative guard is the COUNT below on the
    -- committed attachments table.
    SELECT COUNT(*) INTO v_photo_count
      FROM attachments att
      WHERE att.job_id = p_job_id AND att.tenant_id = p_tenant_id
        AND att.attachment_type = 'photo';

    IF v_photo_count >= 5 THEN
      RAISE EXCEPTION 'PHOTO_LIMIT_EXCEEDED';
    END IF;

    -- Photo insert (AC#5)
    INSERT INTO attachments (job_id, tenant_id, upload_id, r2_key, attachment_type, size_bytes)
      VALUES (p_job_id, p_tenant_id, p_upload_id, v_upload.r2_key, 'photo', p_size_bytes)
      RETURNING id INTO v_att_id;

    SELECT a.created_at INTO v_created_at FROM attachments a WHERE a.id = v_att_id;
  END IF;

  -- 5. Mark staging row confirmed
  UPDATE attachment_uploads SET status = 'confirmed' WHERE id = p_upload_id;

  -- 6. Auto-advance the photo_confirm step on the first confirmed photo.
  --    Template-driven (Story 4.4): read the job's stamped template, find the
  --    step whose advances_on = 'photo_confirm', and advance to it only when
  --    this is the first photo AND current_step is that step's immediate
  --    template predecessor (or NULL when it is the first step). The advance
  --    is delegated to advance_workflow_step, so the activity log, the owner
  --    notification (self-notify guarded), the compare-and-set guard, and the
  --    completed_at stamping are all identical to a manual advance. A PT409
  --    raise (terminal job, or a concurrent advance moved current_step) is
  --    logged and swallowed — the attachment insert above must still succeed.
  IF v_upload.attachment_type = 'photo' THEN
    SELECT COUNT(*) INTO v_photo_count
      FROM attachments att
      WHERE att.job_id = p_job_id AND att.tenant_id = p_tenant_id AND att.attachment_type = 'photo';

    SELECT t.steps INTO v_steps
      FROM jobs j
      JOIN workflow_templates t
        ON t.id = j.workflow_template_id AND t.version = j.workflow_template_version
      WHERE j.id = p_job_id AND j.tenant_id = p_tenant_id;

    IF v_steps IS NOT NULL THEN
      v_n := jsonb_array_length(v_steps);
      FOR v_i IN 0 .. v_n - 1 LOOP
        IF v_steps -> v_i ->> 'advances_on' = 'photo_confirm' THEN
          v_photo_idx := v_i;
          v_photo_key := v_steps -> v_i ->> 'key';
          v_sets_status := v_steps -> v_i ->> 'sets_status';
          EXIT;
        END IF;
      END LOOP;

      IF v_photo_key IS NOT NULL AND v_photo_count = 1 THEN
        v_prev_key := CASE
          WHEN v_photo_idx = 0 THEN NULL
          ELSE v_steps -> (v_photo_idx - 1) ->> 'key'
        END;

        SELECT current_step INTO v_current
          FROM jobs
          WHERE id = p_job_id AND tenant_id = p_tenant_id;

        IF v_current IS NOT DISTINCT FROM v_prev_key THEN
          BEGIN
            PERFORM advance_workflow_step(
              p_job_id, p_tenant_id, p_actor_id,
              v_photo_key, v_sets_status, v_prev_key
            );
          EXCEPTION WHEN SQLSTATE 'PT409' THEN
            RAISE LOG 'confirm_attachment: auto-advance to % skipped for job % (job terminal or step moved concurrently)',
              v_photo_key, p_job_id;
          END;
        END IF;
      END IF;
    END IF;
  END IF;

  RETURN QUERY SELECT v_att_id, v_upload.attachment_type, v_created_at, FALSE;
END $$;
