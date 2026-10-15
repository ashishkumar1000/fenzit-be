-- Employee codes: human-readable per-tenant business references for users
-- (SPEC-human-readable-ids, 2026-10-15). Additive-only: UUID PKs, RLS, and all
-- existing contracts untouched; codes are display references, never authz inputs.
--
-- Ordering matters and is race-safe against live inserts during this migration:
--   1. trigger function exists first (any insert that races the backfill allocates
--      through the counter and serializes on its row lock),
--   2. counter rows seeded at 0 for EVERY tenant before backfill (a racing invite
--      blocks on the uncommitted counter row until this migration commits, then
--      reads the post-backfill max — it can never double-allocate a backfilled
--      number),
--   3. backfill overwrites codes unconditionally (ranked 1..N per tenant), so any
--      pre-backfill trigger allocation is renumbered consistently,
--   4. counters set to each tenant's final max.
-- Codes are write-once: the trigger never re-allocates over an existing code.

ALTER TABLE public.users
  ADD COLUMN employee_code TEXT;

-- Row-locked, monotonic per-tenant counter (job_sequences pattern, 20260621000002).
CREATE TABLE public.employee_sequences (
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  last_seq  INT  NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id)
);

-- Written only by the SECURITY DEFINER trigger function; no client policy needed.
ALTER TABLE public.employee_sequences ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.set_employee_code()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_seq INT;
BEGIN
  -- Tenant-scoped rows without a code only; write-once: never clear-and-reallocate.
  IF NEW.tenant_id IS NULL OR NEW.employee_code IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.employee_code IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- ON CONFLICT upsert takes a row lock, so concurrent inserts serialize and the
  -- counter is monotonic: codes of removed users are never reused.
  INSERT INTO public.employee_sequences (tenant_id, last_seq)
  VALUES (NEW.tenant_id, 1)
  ON CONFLICT (tenant_id)
  DO UPDATE SET last_seq = public.employee_sequences.last_seq + 1
  RETURNING last_seq INTO v_seq;

  NEW.employee_code := 'EMP-' || lpad(v_seq::text, 3, '0');
  RETURN NEW;
END $$;

CREATE TRIGGER users_set_employee_code
  BEFORE INSERT OR UPDATE ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.set_employee_code();

-- House rule (20260925000001): any new DB function revokes public EXECUTE in its
-- own migration. Trigger calls are privilege-exempt; the function is never RPC-called.
REVOKE EXECUTE ON FUNCTION public.set_employee_code() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_employee_code() FROM anon;
REVOKE EXECUTE ON FUNCTION public.set_employee_code() FROM authenticated;

-- Seed counters at 0 for every tenant BEFORE the backfill (see ordering note above).
INSERT INTO public.employee_sequences (tenant_id, last_seq)
SELECT id, 0 FROM public.tenants
ON CONFLICT (tenant_id) DO NOTHING;

-- Backfill: per tenant, oldest first (created_at ASC, id ASC tiebreak), EMP-001..N.
-- Explicit codes mean the trigger no-ops on these rows.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY tenant_id ORDER BY created_at ASC, id ASC) AS rn
  FROM public.users
  WHERE tenant_id IS NOT NULL
)
UPDATE public.users u
SET employee_code = 'EMP-' || lpad(ranked.rn::text, 3, '0')
FROM ranked
WHERE u.id = ranked.id;

-- Counters continue from each tenant's backfilled max.
UPDATE public.employee_sequences es
SET last_seq = sub.cnt
FROM (
  SELECT tenant_id, count(*) AS cnt
  FROM public.users
  WHERE tenant_id IS NOT NULL
  GROUP BY tenant_id
) sub
WHERE es.tenant_id = sub.tenant_id;

-- Named constraint so a 23505 from this index is distinguishable in support triage.
ALTER TABLE public.users
  ADD CONSTRAINT users_tenant_employee_code_unique
  UNIQUE (tenant_id, employee_code);
