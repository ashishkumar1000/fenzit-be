-- Story 4.4 follow-up (code review patch): log the silent auto-advance skip.
-- Migration 37's confirm_attachment skips section 6 entirely when the job's
-- stamped template row is missing (v_steps IS NULL — e.g. a template row
-- deleted after the job was created). That skip was silent. Re-issue the
-- function with a RAISE LOG on that path so it is visible in Postgres logs.
-- Body is otherwise byte-identical to 20260911000003.
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
    ELSE
      -- No template row matches the job's stamp (e.g. the template row was
      -- deleted after the job was created). Skip is correct (the attachment
      -- still commits) — but make it visible in Postgres logs.
      RAISE LOG 'confirm_attachment: no stamped workflow template for job % (auto-advance skipped)',
        p_job_id;
    END IF;
  END IF;

  RETURN QUERY SELECT v_att_id, v_upload.attachment_type, v_created_at, FALSE;
END $$;
