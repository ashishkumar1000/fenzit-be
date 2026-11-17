-- ─────────────────────────────────────────────────────────────────────────────
-- Customers codes/overview hardening — review round on 20261117130000.
-- Three fixes, each one a slipped house rule from the employee-code precedent
-- (20261015000001) or a real query-plan miss:
--
-- 1. customer_sequences had NO row-level security. Supabase's default
--    privileges grant ALL on new public tables to anon/authenticated, so the
--    counter table was PostgREST-readable AND -writable across tenants — a
--    tampered last_seq would mint colliding codes that then hard-fail on the
--    unique index. The table is written only by the SECURITY DEFINER trigger,
--    so RLS with no policies is the correct deny-by-default posture
--    (service_role bypasses RLS and keeps its grants).
--
-- 2. set_customer_code() skipped the house REVOKE EXECUTE block
--    (20260925000001: every new DB function revokes public EXECUTE in its own
--    migration; trigger calls are privilege-exempt, the function is never
--    RPC-called).
--
-- 3. The view's LEFT JOIN carried only j.customer_id = c.id, so the planner
--    could not use idx_jobs_customer_history (tenant_id, customer_id, …) —
--    every page load hash-joined a scan of the whole jobs table across ALL
--    tenants. jobs.tenant_id is NOT NULL, so adding j.tenant_id = c.tenant_id
--    loses nothing and hands the aggregate to the index.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Lock the counter table down (no policies = deny by default).
alter table public.customer_sequences enable row level security;

-- 2. House rule 20260925000001.
revoke execute on function public.set_customer_code() from public;
revoke execute on function public.set_customer_code() from anon;
revoke execute on function public.set_customer_code() from authenticated;

-- 3. Recreate the view with the tenant predicate on the join (create or
--    replace keeps the grants; they are re-asserted below anyway).
create or replace view public.customers_overview
with (security_invoker = true) as
select
  c.id,
  c.tenant_id,
  c.customer_code,
  c.name,
  c.country_code,
  c.phone_number,
  c.address,
  c.city,
  c.formatted_address,
  c.pincode,
  c.latitude,
  c.longitude,
  c.place_id,
  c.address_details,
  c.created_via,
  c.created_at,
  count(j.id)::integer as job_count,
  max(j.scheduled_start) as last_job_date
from public.customers c
left join public.jobs j
  on j.customer_id = c.id
 and j.tenant_id = c.tenant_id
group by c.id;

-- Grants hygiene, re-asserted (20261001000001 precedent).
revoke all on public.customers_overview
  from anon, authenticated, service_role;
grant select on public.customers_overview to service_role;
