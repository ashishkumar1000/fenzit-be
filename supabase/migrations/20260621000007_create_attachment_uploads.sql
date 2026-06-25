-- Staging table for presigned-URL upload sessions (Story 3.6)
-- Rows are created when a presigned PUT URL is issued (status='pending') and
-- marked 'confirmed' once the client confirms the upload completed.
-- Expired/abandoned rows are cleaned up asynchronously (no orphaned data in attachments).
-- RLS is enabled for defense-in-depth; service-role client bypasses it in the app layer.

CREATE TABLE attachment_uploads (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          UUID        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  tenant_id       UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  r2_key          TEXT        NOT NULL UNIQUE,
  attachment_type TEXT        NOT NULL CHECK (attachment_type IN ('photo','signature')),
  mime_type       TEXT        NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','confirmed','expired')),
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_attachment_uploads_job_id ON attachment_uploads (job_id);

ALTER TABLE attachment_uploads ENABLE ROW LEVEL SECURITY;

CREATE POLICY attachment_uploads_tenant_isolation ON attachment_uploads
  FOR ALL
  USING (tenant_id = (auth.jwt() ->> 'tenantId')::uuid)
  WITH CHECK (tenant_id = (auth.jwt() ->> 'tenantId')::uuid);
