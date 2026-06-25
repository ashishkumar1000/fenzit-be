-- RPC for atomic attachment confirmation (Story 3.6)
-- Called via the service-role client (createAdmin), so RLS is bypassed; the function
-- is tenant-scoped via explicit p_tenant_id parameter. PostgREST runs the RPC in a
-- single transaction — staging row update, attachments insert, and optional
-- photos_uploaded auto-advance are all atomic.
--
-- Called by two paths with identical behavior:
--   1. Client confirm: POST /api/v1/jobs/:id/attachments/:uploadId/confirm
--      p_actor_id = user.userId
--   2. Worker webhook: POST /internal/webhooks/storage (future Paid plan)
--      p_actor_id = NULL
--
-- Exception codes the app maps to HTTP errors:
--   UPLOAD_NOT_FOUND      -> 404
--   UPLOAD_EXPIRED        -> 410
--   PHOTO_LIMIT_EXCEEDED  -> 409 (hard 5-photo cap, enforced at confirm time)
-- A concurrent signature unique_violation (23505) is caught internally and
-- resolved idempotently (re-reads the winning row) — never surfaces to a caller.
-- jobs.updated_at has no BEFORE UPDATE trigger, so UPDATE sets it explicitly.

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
  v_upload     attachment_uploads%ROWTYPE;
  v_att_id     UUID;
  v_created_at TIMESTAMPTZ;
  v_photo_count BIGINT;
  v_step       TEXT;
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

  -- 2. Idempotent: already confirmed — return existing attachments row (AC#9)
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
    -- Signature upsert: replace existing signature for this job (AC#7)
    UPDATE attachments att
      SET r2_key     = v_upload.r2_key,
          upload_id  = p_upload_id,
          size_bytes = p_size_bytes,
          created_at = now()
      WHERE att.job_id = p_job_id
        AND att.tenant_id = p_tenant_id
        AND att.attachment_type = 'signature'
      RETURNING att.id INTO v_att_id;

    IF NOT FOUND THEN
      -- No existing signature row: INSERT. Under genuine concurrency, two
      -- confirms can both reach NOT FOUND and both attempt the INSERT; the
      -- partial unique index uniq_attachments_signature_per_job (migration 010)
      -- makes the loser raise unique_violation (23505). Resolve idempotently —
      -- the winning row already satisfies AC#7 (exactly one signature) — instead
      -- of bubbling a 23505 up to a 500 / Worker poison-retry.
      BEGIN
        INSERT INTO attachments (job_id, tenant_id, upload_id, r2_key, attachment_type, size_bytes)
          VALUES (p_job_id, p_tenant_id, p_upload_id, v_upload.r2_key, 'signature', p_size_bytes)
          RETURNING id INTO v_att_id;
      EXCEPTION WHEN unique_violation THEN
        SELECT a.id INTO v_att_id
          FROM attachments a
          WHERE a.job_id = p_job_id
            AND a.tenant_id = p_tenant_id
            AND a.attachment_type = 'signature';
      END;
    END IF;

    SELECT a.created_at INTO v_created_at FROM attachments a WHERE a.id = v_att_id;
  ELSE
    -- Hard-enforce the 5-photo cap at confirm time (AC#4). The request-time
    -- check in AttachmentsService is a check-then-act read and is racy: N
    -- parallel requests all see count < 5 and mint presigned URLs. This count
    -- runs while the staging row is held under FOR UPDATE, but note photos are
    -- separate staging rows — the authoritative guard is the COUNT below on the
    -- committed attachments table. Two genuinely concurrent confirms can still
    -- both read 4 under READ COMMITTED; a UNIQUE/exclusion constraint would be
    -- needed for a hard guarantee, but this closes the common (sequential and
    -- request-before-confirm) bypass and keeps the error path clean.
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

  -- 6. Auto-advance photos_uploaded on first confirmed photo (AC#6)
  --    Only fires when current_step = 'in_progress' and this is the first photo.
  IF v_upload.attachment_type = 'photo' THEN
    SELECT COUNT(*) INTO v_photo_count
      FROM attachments att
      WHERE att.job_id = p_job_id AND att.tenant_id = p_tenant_id AND att.attachment_type = 'photo';

    SELECT current_step INTO v_step
      FROM jobs
      WHERE id = p_job_id AND tenant_id = p_tenant_id;

    IF v_photo_count = 1 AND v_step = 'in_progress' THEN
      UPDATE jobs
        SET current_step = 'photos_uploaded',
            updated_at   = now()
        WHERE id = p_job_id AND tenant_id = p_tenant_id;

      INSERT INTO activity_logs (job_id, tenant_id, event_type, actor_id)
        VALUES (p_job_id, p_tenant_id, 'step_photos_uploaded', p_actor_id);
    END IF;
  END IF;

  RETURN QUERY SELECT v_att_id, v_upload.attachment_type, v_created_at, FALSE;
END $$;
