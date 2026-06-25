-- Create tenant_skills table
CREATE TABLE tenant_skills (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness per tenant
CREATE UNIQUE INDEX tenant_skills_tenant_id_name_unique
  ON tenant_skills (tenant_id, lower(name));

-- Create user_skills junction table
CREATE TABLE user_skills (
  user_id   UUID NOT NULL REFERENCES users(id)         ON DELETE CASCADE,
  skill_id  UUID NOT NULL REFERENCES tenant_skills(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, skill_id)
);

-- Drop the old hardcoded skill_type column from users
ALTER TABLE users DROP COLUMN IF EXISTS skill_type;

-- RLS on tenant_skills
ALTER TABLE tenant_skills ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_skills_tenant_isolation"
  ON tenant_skills
  FOR ALL
  USING (tenant_id = (auth.jwt() ->> 'tenantId')::uuid)
  WITH CHECK (tenant_id = (auth.jwt() ->> 'tenantId')::uuid);

-- RLS on user_skills (via skill's tenant)
ALTER TABLE user_skills ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_skills_tenant_isolation"
  ON user_skills
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM tenant_skills ts
      WHERE ts.id = user_skills.skill_id
        AND ts.tenant_id = (auth.jwt() ->> 'tenantId')::uuid
    )
  );
