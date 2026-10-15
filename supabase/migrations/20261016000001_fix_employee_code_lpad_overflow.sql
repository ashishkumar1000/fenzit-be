-- Employee codes: fix code rendering for sequences ≥ 1000 (SPEC-human-readable-ids
-- edge-case round, 2026-10-16). lpad TRUNCATES inputs longer than the pad width:
-- lpad('1000', 3, '0') = '100', so tenant #1000 would mint 'EMP-100' (already
-- taken) and hard-fail on users_tenant_employee_code_unique. GREATEST(3, length)
-- pads 1-999 exactly as before and renders 4+ digit sequences in full (EMP-1000,
-- EMP-1001, …). Pure function-body replace — no schema change.

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

  NEW.employee_code := 'EMP-' || lpad(v_seq::text, GREATEST(3, length(v_seq::text)), '0');
  RETURN NEW;
END $$;

-- House rule: revoke public EXECUTE (trigger calls are privilege-exempt).
REVOKE EXECUTE ON FUNCTION public.set_employee_code() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_employee_code() FROM anon;
REVOKE EXECUTE ON FUNCTION public.set_employee_code() FROM authenticated;
