-- Confirmed attachments table (Story 3.6)
-- Only confirmed uploads land here — no pending/expired rows.
-- upload_id references the staging row (SET NULL on delete so cleanup doesn't break attachments).
-- Photo ordering uses created_at ASC (stable, no gap-on-delete issues vs photo_index).
-- Also makes activity_logs.actor_id nullable so webhook-triggered log entries
-- (no human actor) can pass NULL (p_actor_id = NULL in confirm_attachment RPC).

CREATE TABLE attachments (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          UUID        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  tenant_id       UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  upload_id       UUID        REFERENCES attachment_uploads(id) ON DELETE SET NULL,
  r2_key          TEXT        NOT NULL UNIQUE,
  attachment_type TEXT        NOT NULL CHECK (attachment_type IN ('photo','signature')),
  size_bytes      INT         NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_attachments_job_id ON attachments (job_id);

ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;

CREATE POLICY attachments_tenant_isolation ON attachments
  FOR ALL
  USING (tenant_id = (auth.jwt() ->> 'tenantId')::uuid)
  WITH CHECK (tenant_id = (auth.jwt() ->> 'tenantId')::uuid);

-- Make actor_id nullable so confirm_attachment RPC can insert activity log
-- entries with NULL actor when called from a Worker (no human actor).
ALTER TABLE activity_logs ALTER COLUMN actor_id DROP NOT NULL;
