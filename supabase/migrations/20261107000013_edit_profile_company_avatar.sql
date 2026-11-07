-- Edit Profile: company GST, company business types, and a personal photo.
--
-- Additive only (fenzit-be deploys before fenzit-app). Pre-launch, so no
-- backfill is needed: no tenant has a GSTIN yet (checked before this change),
-- and no user has an avatar.
--
-- Plain-English contract:
--   * business_types   — the managed list of business types. The app never
--                        hard-codes it; GET /business-types serves it.
--   * tenant_business_types — which types a company picked (many per company).
--   * users.avatar_key — storage key of the person's own photo, or NULL.
--   * tenants.gstin    — now format-checked by the database as well as the API.
-- Both new tables have RLS on. Only the backend (service client) writes them.

-- 1) Managed business-type list ---------------------------------------------

CREATE TABLE business_types (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code        TEXT NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  label       TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 60),
  sort_order  INTEGER NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE business_types ENABLE ROW LEVEL SECURITY;
-- No policies: deny-by-default for anon and authenticated. The backend reads
-- this list through its service client and serves it on GET /business-types.

INSERT INTO business_types (code, label, sort_order) VALUES
  ('ac_hvac',            'AC & HVAC service',                 1),
  ('electrical',         'Electrical service',                2),
  ('plumbing',           'Plumbing service',                  3),
  ('appliance_repair',   'Appliance repair',                  4),
  ('pest_control',       'Pest control',                      5),
  ('cleaning',           'Cleaning service',                  6),
  ('carpentry',          'Carpentry',                         7),
  ('painting',           'Painting & waterproofing',          8),
  ('interior',           'Interior & renovation',             9),
  ('locksmith',          'Locksmith',                        10),
  ('cctv_security',      'CCTV & security systems',          11),
  ('solar',              'Solar installation & cleaning',    12),
  ('water_tank',         'Water tank & RO service',          13),
  ('gardening',          'Gardening & landscaping',          14),
  ('general_maintenance','General maintenance',              15),
  ('tuition',            'Tuition & coaching',               16),
  ('training',           'Corporate training',               17),
  ('salon_at_home',      'Salon & beauty at home',           18),
  ('wellness',           'Massage & wellness at home',       19),
  ('pet_care',           'Pet grooming & care',              20),
  ('elderly_care',       'Elderly & patient care',           21),
  ('childcare',          'Babysitting & nanny services',     22),
  ('logistics',          'Packers & movers',                 23),
  ('delivery',           'Delivery service',                 24),
  ('driving',            'Driver & chauffeur service',       25),
  ('it_services',        'IT & computer services',           26),
  ('digital_marketing',  'Digital marketing & design',       27),
  ('accounting',         'Accounts & tax services',          28),
  ('staffing',           'Staffing & HR services',           29),
  ('office_admin',       'Office support & admin',           30),
  ('catering',           'Catering & cooking',               31),
  ('other',              'Other',                            32);

-- 2) Company -> business types ------------------------------------------------

CREATE TABLE tenant_business_types (
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  business_type_id  UUID NOT NULL REFERENCES business_types(id) ON DELETE RESTRICT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, business_type_id)
);

CREATE INDEX idx_tenant_business_types_type ON tenant_business_types (business_type_id);

ALTER TABLE tenant_business_types ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_business_types_read_own ON tenant_business_types
  FOR SELECT
  USING (tenant_id = (auth.jwt() ->> 'tenantId')::uuid);

-- 3) Personal photo key -------------------------------------------------------
-- Key shape: avatars/<user id>/<random uuid>.<jpg|png>. The check pins the
-- folder to the owner's own id format; the backend also checks the owner id.

ALTER TABLE users
  ADD COLUMN avatar_key TEXT
  CHECK (
    avatar_key IS NULL
    OR avatar_key ~ '^avatars/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png)$'
  );

-- 4) GSTIN format (15 characters, Indian GST registration number) ------------

ALTER TABLE tenants
  ADD CONSTRAINT tenants_gstin_format CHECK (
    gstin IS NULL
    OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'
  );
