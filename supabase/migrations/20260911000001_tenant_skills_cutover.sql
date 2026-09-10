-- Story 4.2: technician skills cut over to the global skills catalog
--
-- user_skills.skill_id retargets to the global `skills` table (Story 4.1's
-- seed UUIDs). The per-tenant `tenant_skills` table — the third competing
-- skill vocabulary — is dropped, along with `tenants.service_categories`
-- and the RPC param that wrote it. Pre-launch clean cutover: tenant_skills
-- has no rows, so no data migration or backfill is needed.

-- 1) Retarget user_skills.skill_id. The old FK cascade-deleted assignments
--    when a tenant skill was deleted; the global catalog is never deleted
--    through the API (deactivation via is_active is the only mechanism), so
--    the new FK RESTRICTs — an accidental skill deletion must fail loudly,
--    not silently strip technician skills.
ALTER TABLE user_skills DROP CONSTRAINT user_skills_skill_id_fkey;

ALTER TABLE user_skills
  ADD CONSTRAINT user_skills_skill_id_fkey
  FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE RESTRICT;

-- 2) Rewrite user_skills RLS without the tenant_skills subquery: scope via
--    the owning user's tenant instead. Same policy name and FOR ALL posture
--    as before; WITH CHECK is now explicit (INSERTs must land on the
--    caller's own tenant's users).
DROP POLICY IF EXISTS user_skills_tenant_isolation ON user_skills;

CREATE POLICY user_skills_tenant_isolation ON user_skills
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = user_skills.user_id
        AND u.tenant_id = (auth.jwt() ->> 'tenantId')::uuid
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = user_skills.user_id
        AND u.tenant_id = (auth.jwt() ->> 'tenantId')::uuid
    )
  );

-- 3) Drop the old function first — CREATE OR REPLACE cannot change the
--    parameter list, and it references the column dropped in step 5.
DROP FUNCTION IF EXISTS setup_tenant_for_owner(UUID, TEXT, TEXT, TEXT, TEXT, TEXT[], TEXT);

-- 4) Drop the tenant_skills table (its RLS policy goes with it).
DROP TABLE tenant_skills;

-- 5) Drop the service_categories column — signup no longer classifies the
--    business; skills come from the global catalog at technician invite.
ALTER TABLE tenants DROP COLUMN service_categories;

-- 6) Recreate the setup RPC without p_service_categories.
CREATE FUNCTION setup_tenant_for_owner(
  p_user_id      UUID,
  p_company_name TEXT,
  p_gstin        TEXT,
  p_address      TEXT,
  p_state_code   TEXT,
  p_upi_vpa      TEXT
)
RETURNS TABLE (
  id UUID,
  owner_id UUID,
  company_name TEXT,
  gstin TEXT,
  address TEXT,
  state_code TEXT,
  upi_vpa TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  inserted BOOLEAN
)
LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE
  v_tenant_id  UUID;
  v_inserted   BOOLEAN;
BEGIN
  INSERT INTO tenants (
    owner_id, company_name, gstin, address, state_code, upi_vpa
  )
  VALUES (
    p_user_id, p_company_name, p_gstin, p_address, p_state_code, p_upi_vpa
  )
  ON CONFLICT (owner_id) DO UPDATE SET
    company_name = EXCLUDED.company_name,
    gstin        = EXCLUDED.gstin,
    address      = EXCLUDED.address,
    state_code   = EXCLUDED.state_code,
    upi_vpa      = EXCLUDED.upi_vpa,
    updated_at   = now()
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
           t.upi_vpa, t.created_at, t.updated_at, v_inserted
      FROM tenants t
     WHERE t.id = v_tenant_id;
END $$;
