-- D2: Allow the same phone number to be a technician in multiple tenants.
--
-- Old constraint: UNIQUE(country_code, phone_number) — global, one phone = one user ever.
-- New approach: two partial unique indexes:
--   1. Unaffiliated users (owners before company setup, tenant_id IS NULL):
--      unique per phone globally.
--   2. Tenant-affiliated users (tenant_id IS NOT NULL):
--      unique per (phone, tenant) — same phone allowed in different tenants.
--
-- NOTE: findOrCreateUser uses .single() — it will need a tenant-aware lookup
-- before multi-tenant invite is actually exercised in production.

-- Drop the global unique constraint added in migration 000002
ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_country_code_phone_number_unique;

-- Partial index: phone must be globally unique when not yet assigned to a tenant
CREATE UNIQUE INDEX users_phone_no_tenant_unique
  ON users (country_code, phone_number)
  WHERE tenant_id IS NULL;

-- Partial index: phone must be unique within each tenant
CREATE UNIQUE INDEX users_phone_per_tenant_unique
  ON users (country_code, phone_number, tenant_id)
  WHERE tenant_id IS NOT NULL;
