-- Story 23-3 review round: two fixes from the code-review triage.
--
-- 1. The exactly-one-basic rule (CAP-1) gets its storage backstop: a partial
--    unique index, so two concurrent "make this basic" writes cannot both
--    land. An index is not a function — the zero-functions boundary holds.
--    The service's probe stays (it is what names the current basic in the
--    409); this index is the race backstop its 23505 branch maps.
--
-- 2. Hygiene on 20261117120000: drop the tautological
--    effective_from_is_date_check (always true on a date column) and the
--    membership/effective_from index that merely duplicates the index the
--    unique constraint already creates.

create unique index if not exists salary_components_tenant_basic_uq
  on public.salary_components (tenant_id)
  where is_basic;

alter table public.salary_structures
  drop constraint if exists salary_structures_effective_from_is_date_check;

drop index if exists public.salary_structures_membership_effective_idx;

comment on constraint salary_structures_membership_effective_uq on public.salary_structures is
  'One dated revision per month boundary: a same-date save replaces the row, a different date is a new revision. Its own index serves the run''s per-membership month lookup.';
