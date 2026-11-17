-- ─────────────────────────────────────────────────────────────────────────────
-- Customers overview + customer codes (console customers-page redesign)
--
-- Two additive pieces, both owned by the customers page:
--
-- 1. public.customers_overview — one row per customer with its job aggregate
--    (job_count, last_job_date). The console's paged list filters and sorts
--    on these columns IN THE DATABASE (a company can hold thousands of
--    customers — members-page-style full-table folding in the service would
--    pull every row on every page). The aggregate rides the existing
--    idx_jobs_customer_history (tenant_id, customer_id, scheduled_start DESC).
--    security_invoker keeps the view behind the base tables' RLS even for a
--    future non-service invoker (house pattern, 20261001000001); PostgREST
--    visibility stays closed via the grants block below.
--
-- 2. Customer codes (CST-NNN) — the display identity the console shows beside
--    a customer's name, cloned from the proven employee-code mechanism
--    (20261015000001, moved onto memberships by 20261020000003): a per-tenant
--    counter table, a BEFORE INSERT trigger that mints the next code
--    (ON CONFLICT ... RETURNING row lock = race-safe, gap-free), write-once
--    semantics, tenant-unique, and an oldest-first backfill whose counters
--    continue from the max assigned. Codes are display-only — never authz,
--    never a join key. (Hardening rides 20261117140000: table RLS, fn REVOKE,
--    tenant predicate on the view's join.)
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Customer codes ───────────────────────────────────────────────────────

alter table public.customers add column if not exists customer_code text;

-- Every customer of a tenant carries a distinct code. The trigger fills it
-- on insert, the backfill fills the existing rows, so a plain unique index
-- holds; it also documents the invariant for future writers.
create unique index if not exists customers_tenant_code_unique
  on public.customers (tenant_id, customer_code);

create table if not exists public.customer_sequences (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  last_seq  integer NOT NULL DEFAULT 0
);

-- Same shape as set_employee_code(): SECURITY DEFINER so the counter bump and
-- the row insert commit as one; search_path pinned; a caller that already
-- supplied a code keeps it (write-once).
CREATE OR REPLACE FUNCTION public.set_customer_code() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_seq INT;
BEGIN
  IF NEW.customer_code IS NOT NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.customer_sequences (tenant_id, last_seq)
  VALUES (NEW.tenant_id, 1)
  ON CONFLICT (tenant_id)
  DO UPDATE SET last_seq = public.customer_sequences.last_seq + 1
  RETURNING last_seq INTO v_seq;

  -- Fixed-width seat (CST-001) that widens itself past 999 — the lpad
  -- overflow fix from 20261016000001.
  NEW.customer_code := 'CST-' || lpad(v_seq::text, GREATEST(3, length(v_seq::text)), '0');
  RETURN NEW;
END $$;

drop trigger if exists customers_set_customer_code on public.customers;

create trigger customers_set_customer_code
  before insert on public.customers
  for each row execute function public.set_customer_code();

-- Backfill: oldest customer of each tenant gets the lowest code (a person
-- expects the founding customers up top), id as the tiebreak so a same-
-- timestamp pair is deterministic. Counters then continue from the max
-- assigned per tenant — no code is ever minted twice.
with ranked as (
  select id, tenant_id,
         row_number() over (
           partition by tenant_id
           order by created_at asc, id asc
         ) as rn
  from public.customers
  where customer_code is null
)
update public.customers c
set customer_code = 'CST-' || lpad(ranked.rn::text, greatest(3, length(ranked.rn::text)), '0')
from ranked
where ranked.id = c.id
  and c.customer_code is null;

insert into public.customer_sequences (tenant_id, last_seq)
select c.tenant_id,
       max((regexp_replace(c.customer_code, '^CST-', ''))::integer)
from public.customers c
where c.customer_code is not null
group by c.tenant_id
on conflict (tenant_id) do update
  set last_seq = greatest(public.customer_sequences.last_seq, excluded.last_seq);

-- ── 2. The overview view ────────────────────────────────────────────────────

-- Group by the PK: every customers column is functionally dependent on
-- customers.id, so PG17 takes the bare columns. Counts/maxes land as real
-- columns the service can filter (`job_count = 0` for new leads) and sort on.
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
left join public.jobs j on j.customer_id = c.id
group by c.id;

-- Grants hygiene, re-asserted (20261001000001 precedent: the view must stay
-- invisible to PostgREST; only the backend's service_role reads it). Create
-- or replace does not re-grant, so this block rides every future revision.
revoke all on public.customers_overview
  from anon, authenticated, service_role;
grant select on public.customers_overview to service_role;
