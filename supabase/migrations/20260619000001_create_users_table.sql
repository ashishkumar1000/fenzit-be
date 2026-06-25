-- Create users' table with phone-based authentication
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone         TEXT UNIQUE NOT NULL,
  name          TEXT,
  role          TEXT NOT NULL CHECK (role IN ('owner', 'technician')),
  tenant_id     UUID,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invited')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create index for phone lookups (used in OTP verified)
CREATE INDEX idx_users_phone ON users (phone);

-- Create index for tenant lookups (used in job creation, customer access)
CREATE INDEX idx_users_tenant_id ON users (tenant_id);

-- Enable RLS for multi-tenancy
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Users can read their own record or when tenant_id is NULL (first-time login before company setup)
CREATE POLICY users_read_own_or_null_tenant ON users
  FOR SELECT
  USING (
    auth.jwt() ->> 'sub' = id::text
    OR tenant_id IS NULL
    OR tenant_id = (auth.jwt() ->> 'tenantId')::uuid
  );

-- RLS Policy: Only service role (or future auth system) can insert users
CREATE POLICY users_insert_only_service_role ON users
  FOR INSERT
  WITH CHECK (false);  -- Will be updated by service role calls from application

-- RLS Policy: Users can update their own record
CREATE POLICY users_update_own ON users
  FOR UPDATE
  USING (auth.jwt() ->> 'sub' = id::text)
  WITH CHECK (auth.jwt() ->> 'sub' = id::text);
