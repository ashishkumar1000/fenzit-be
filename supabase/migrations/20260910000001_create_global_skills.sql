-- Story 4.1: global skills catalog (developer-seeded, read-only API)
--
-- One fixed platform-wide skill vocabulary. Seeded ONLY here — no API or
-- signup path writes to this table. Stories 4.2/4.3 reference these fixed
-- seed UUIDs in their own migrations, so they must never change.
--
-- sort_order pins the documented seed order: all rows in this single INSERT
-- share one transaction-stable now(), so created_at cannot order them and the
-- API orders by sort_order instead (review fix, 2026-09-10). UNIQUE so a
-- future seed migration cannot silently introduce ties (review round 2).

CREATE TABLE skills (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT        NOT NULL,
  sort_order INT         NOT NULL,
  is_active  BOOLEAN     NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness so 'ac service' and 'AC Service' can never
-- both exist (mirrors the tenant_skills unique index pattern).
CREATE UNIQUE INDEX skills_name_unique ON skills (lower(name));

-- Ties on sort_order would make the pinned seed order nondeterministic.
CREATE UNIQUE INDEX skills_sort_order_unique ON skills (sort_order);

ALTER TABLE skills ENABLE ROW LEVEL SECURITY;

-- Global reference table: any authenticated user can read. Writes are denied
-- via RLS, not via grants — anon/authenticated keep their default table
-- grants, but no write policy exists so no client can write (review round 2:
-- wording corrected; deliberately scoped TO authenticated, unlike the
-- country_codes policy which is TO public because the login screen reads it).
CREATE POLICY "skills_authenticated_read" ON skills
  FOR SELECT TO authenticated
  USING (true);

INSERT INTO skills (id, name, sort_order) VALUES
  ('d89d67f7-c0fe-42f8-9f76-c1660c98ce97', 'Plumbing', 1),
  ('77d9450a-f9a4-4992-a82a-cdf27063e9e9', 'Electrical', 2),
  ('65f33480-b37e-47e2-a4a0-0155b156cc7a', 'AC Service', 3),
  ('95f021b0-a973-45fc-b73f-db0dc5afd4a0', 'AC Installation', 4),
  ('71cc840c-3663-489e-bbf2-867d92c46619', 'Pest Control', 5),
  ('72f67596-fec7-4ae8-a6f1-fceabaef0d7d', 'Cleaning', 6);
