-- Create customers table (Story 2.1)
-- Phone is stored split as (country_code, phone_number) to match the users table
-- (see 20260620000002_split_phone_add_country_codes.sql), NOT as a single E.164 string.
CREATE TABLE customers (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         TEXT        NOT NULL,
  country_code TEXT        NOT NULL REFERENCES country_codes(dial_code),
  phone_number TEXT        NOT NULL,
  address      TEXT,
  city         TEXT,
  created_via  TEXT        NOT NULL DEFAULT 'manual'
                 CHECK (created_via IN ('manual', 'job_creation')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One customer per phone per tenant
CREATE UNIQUE INDEX customers_tenant_phone_unique
  ON customers (tenant_id, country_code, phone_number);

-- RLS: tenant isolation (defense-in-depth; application layer also filters by tenant_id)
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "customers_tenant_isolation"
  ON customers
  FOR ALL
  USING (tenant_id = (auth.jwt() ->> 'tenantId')::uuid)
  WITH CHECK (tenant_id = (auth.jwt() ->> 'tenantId')::uuid);
