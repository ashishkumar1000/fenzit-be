-- Bulk customer import (spec-owner-bulk-customer-import, story 2).
--
-- Plain-English contract:
--   * customers.created_via may now also be 'bulk_import', so a customer
--     added from a staff-uploaded sheet is tagged as such. The existing
--     values 'manual' and 'job_creation' are kept.
--   * import_batches holds ONE row per import run: who ran it, which
--     company it was for, the file name, and how many rows were created,
--     updated or failed. It is the audit record for the run.
--   * Pre-launch, so no backfill is needed. The existing unique index on
--     customers (tenant_id, country_code, phone_number) is NOT touched; the
--     import relies on it to match phones.
--
-- Access: import_batches has RLS on and NO policies, so anon and
-- authenticated users can read or write nothing. Only the backend, through
-- its service client, reads and writes it. Table grants are cleared first
-- and only service_role gets the privileges the backend uses (same pattern
-- as story 15-2 / 15-7).

-- 0) State column for the import sheet ---------------------------------------
-- Optional, nullable. Written only by the bulk import (the manual create and
-- edit forms do not set it yet). Max 100 characters, same as city.
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS state VARCHAR(100);

-- 1) Allow the new created_via value ------------------------------------------
--
-- The original CHECK on customers.created_via came from
-- 20260621000001_create_customers_table.sql. No later migration changed it,
-- so the constraint is the one Postgres auto-named. The DO block finds any
-- CHECK on customers that mentions created_via, so the name does not matter.

DO $$
DECLARE
  c_name TEXT;
BEGIN
  FOR c_name IN
    SELECT con.conname
    FROM pg_constraint con
    WHERE con.conrelid = 'public.customers'::regclass
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%created_via%'
  LOOP
    EXECUTE format('ALTER TABLE public.customers DROP CONSTRAINT %I', c_name);
  END LOOP;
END $$;

ALTER TABLE public.customers
  ADD CONSTRAINT customers_created_via_check
  CHECK (created_via IN ('manual', 'job_creation', 'bulk_import'));

-- 2) One audit row per import run ---------------------------------------------

CREATE TABLE public.import_batches (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID        NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  actor_user_id   UUID        NOT NULL REFERENCES public.users (id),
  file_name       TEXT        NOT NULL
                    CHECK (char_length(file_name) BETWEEN 1 AND 255),
  row_total       INTEGER     NOT NULL CHECK (row_total >= 0),
  created_count   INTEGER     NOT NULL CHECK (created_count >= 0),
  updated_count   INTEGER     NOT NULL CHECK (updated_count >= 0),
  failed_count    INTEGER     NOT NULL CHECK (failed_count >= 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Every row in the run ends up as exactly one of created, updated or failed.
  CONSTRAINT import_batches_row_counts_check
    CHECK (created_count + updated_count + failed_count = row_total)
);

-- Newest runs first for a company's history view.
CREATE INDEX import_batches_tenant_created_idx
  ON public.import_batches (tenant_id, created_at DESC);

-- Deny by default: RLS on, no policies.
ALTER TABLE public.import_batches ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.import_batches FROM public, anon, authenticated;
GRANT SELECT, INSERT ON public.import_batches TO service_role;
