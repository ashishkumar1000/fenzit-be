-- Story 1.3: Tenant company onboarding
-- Creates tenants table, FK from users.tenant_id, RLS for tenant reads,
-- and the setup_tenant_for_owner RPC for atomic upsert + user FK update.

CREATE TABLE tenants (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id            UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  company_name        TEXT NOT NULL,
  gstin               TEXT,
  address             TEXT,
  state_code          TEXT NOT NULL CHECK (state_code ~ '^[A-Z]{2}$'),
  service_categories  TEXT[] NOT NULL DEFAULT '{}',
  upi_vpa             TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tenants_owner_id ON tenants (owner_id);

ALTER TABLE users
  ADD CONSTRAINT users_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenants_read_own ON tenants
  FOR SELECT
  USING (owner_id = (auth.jwt() ->> 'sub')::uuid);

-- Atomic upsert + user FK update.
-- Returns the tenant row plus an `inserted` flag (true on 201, false on 200).
-- PostgREST auto-wraps RPC calls in a transaction.
CREATE OR REPLACE FUNCTION setup_tenant_for_owner(
  p_user_id            UUID,
  p_company_name       TEXT,
  p_gstin              TEXT,
  p_address            TEXT,
  p_state_code         TEXT,
  p_service_categories TEXT[],
  p_upi_vpa            TEXT
)
RETURNS TABLE (
  id UUID,
  owner_id UUID,
  company_name TEXT,
  gstin TEXT,
  address TEXT,
  state_code TEXT,
  service_categories TEXT[],
  upi_vpa TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  inserted BOOLEAN
)
LANGUAGE plpgsql AS $$
DECLARE
  v_tenant_id  UUID;
  v_inserted   BOOLEAN;
BEGIN
  INSERT INTO tenants (
    owner_id, company_name, gstin, address, state_code,
    service_categories, upi_vpa
  )
  VALUES (
    p_user_id, p_company_name, p_gstin, p_address, p_state_code,
    COALESCE(p_service_categories, '{}'), p_upi_vpa
  )
  ON CONFLICT (owner_id) DO UPDATE SET
    company_name       = EXCLUDED.company_name,
    gstin              = EXCLUDED.gstin,
    address            = EXCLUDED.address,
    state_code         = EXCLUDED.state_code,
    service_categories = EXCLUDED.service_categories,
    upi_vpa            = EXCLUDED.upi_vpa,
    updated_at         = now()
  RETURNING tenants.id, (xmax = 0) INTO v_tenant_id, v_inserted;

  IF v_inserted THEN
    UPDATE users
       SET tenant_id = v_tenant_id,
           updated_at = now()
     WHERE id = p_user_id
       AND tenant_id IS NULL;
  END IF;

  RETURN QUERY
    SELECT t.id, t.owner_id, t.company_name, t.gstin, t.address, t.state_code,
           t.service_categories, t.upi_vpa, t.created_at, t.updated_at,
           v_inserted
      FROM tenants t
     WHERE t.id = v_tenant_id;
END $$;
