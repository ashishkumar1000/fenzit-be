-- Create jobs, activity_logs, and job_sequences tables (Story 3.1)
-- Phone/customer linkage uses the customers table (Story 2.1). Tenant isolation
-- is enforced at the app layer (createAdmin bypasses RLS); these RLS policies are
-- defense-in-depth, mirroring customers_tenant_isolation.

-- ============ jobs ============
CREATE TABLE jobs (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_number                TEXT        NOT NULL,
  customer_id               UUID        NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  technician_id             UUID        NOT NULL REFERENCES users(id)     ON DELETE RESTRICT,
  service_location          TEXT        NOT NULL,
  service_type              TEXT        NOT NULL CHECK (service_type IN
                              ('ac_service','ac_installation','pest_control','plumbing','electrical','other')),
  scheduled_start           TIMESTAMPTZ NOT NULL,
  scheduled_end             TIMESTAMPTZ,
  status                    TEXT        NOT NULL DEFAULT 'scheduled'
                              CHECK (status IN ('scheduled','in_progress','completed','cancelled')),
  current_step              TEXT,
  priority                  TEXT        NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','urgent')),
  require_completion_photo  BOOLEAN     NOT NULL DEFAULT false,
  description               TEXT,
  notes_for_technician      TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- job_number is unique per tenant (the sequence guarantees uniqueness; this is a safety net)
CREATE UNIQUE INDEX jobs_tenant_job_number_unique ON jobs (tenant_id, job_number);
-- list-by-day query support (Story 3.2)
CREATE INDEX idx_jobs_tenant_id_scheduled_start ON jobs (tenant_id, scheduled_start);

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "jobs_tenant_isolation"
  ON jobs
  FOR ALL
  USING (tenant_id = (auth.jwt() ->> 'tenantId')::uuid)
  WITH CHECK (tenant_id = (auth.jwt() ->> 'tenantId')::uuid);

-- ============ activity_logs (append-only; immutability is app-enforced in Phase 1) ============
CREATE TABLE activity_logs (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      UUID        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  tenant_id   UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_type  TEXT        NOT NULL,
  actor_id    UUID        NOT NULL REFERENCES users(id),
  metadata    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_activity_logs_job_id ON activity_logs (job_id, created_at);

ALTER TABLE activity_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "activity_logs_tenant_isolation"
  ON activity_logs
  FOR ALL
  USING (tenant_id = (auth.jwt() ->> 'tenantId')::uuid)
  WITH CHECK (tenant_id = (auth.jwt() ->> 'tenantId')::uuid);

-- ============ job_sequences (per-tenant per-year counter) ============
-- (tenant_id, year) PK makes year rollover automatic: a new calendar year inserts
-- a fresh row starting at 1, so no reset/cron is needed (AR-12).
CREATE TABLE job_sequences (
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  year       INT  NOT NULL,
  last_seq   INT  NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, year)
);

-- Written only by the SECURITY DEFINER increment_job_counter RPC (service role); no client policy needed.
ALTER TABLE job_sequences ENABLE ROW LEVEL SECURITY;
