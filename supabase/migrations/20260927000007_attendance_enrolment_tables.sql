-- Story 15-7 (Epic 15): Enrolment, office assignment & access state.
--
-- Effective-dated lifecycle tables (AD-8) + the access-state view (AD-17).
-- NO new executable functions in this file except the constraint trigger's
-- internal helper (triggers are not callable and carry no EXECUTE grant —
-- the user's 2026-09-28 "no new RPCs" decision removes the RPC layer, and
-- the enrolment lifecycle runs transactionally in the NestJS service over
-- the direct pg connection instead; see spec-15-7, Change Log).
--
-- Tables:
--   attendance_enrolments (employee_id, valid daterange, enabled_at) — one
--     row per tracked period; enabled_at feeds FR-2's grace rule (16-1's
--     AD-22 day context reads it; this story only stores it).
--   attendance_office_assignments (employee_id, office_id, valid) — the
--     employee→office placement per period (FR-6: exactly one office on any
--     tracked date).
--   attendance_onboarding (employee_id PK, onboarded_at) — FR-4's once-per-
--     employee onboarding record; first write wins (idempotent upsert).
--
-- Invariant (AD-8): every enrolled date is covered by exactly one LIVE
-- (non-archived) office assignment, and no assigned date falls outside an
-- enrolment. The EXCLUDE constraints give at-most-one overlapping range per
-- employee; the DEFERRABLE INITIALLY DEFERRED constraint trigger gives the
-- coverage/attribution both ways, validated at COMMIT — viable only because
-- every write path is a single pg transaction. Enable co-writes enrolment +
-- assignment atomically, so the service can never strand a date.
--
-- attendance_access_state (view, AD-17): the single source of access state.
--   none         never tracked, or the module kill switch is off
--                (attendance_settings.enabled = false — FR-1: no attendance
--                UI unless the wizard completed; history rows untouched)
--   upcoming     next tracked period starts in the future
--   active       an enrolment covers attendance_today (existing helper)
--   history_only past periods only
-- plus attendance_start_date (covering or next period start), onboarded_at,
-- and the live covering assignment's office. Consumed by me/access, the
-- /users/me technician mirror and the owner roster — all read the same rows,
-- so access state is computed exactly once, in SQL.
--
-- Access: RLS enabled with NO policies on all three tables (deny-by-default;
-- the admin client and the pg pool's service credentials are the only
-- writers — 15-2/15-3/15-5 pattern). The view is revoked from anon and
-- authenticated (its owner bypasses the base tables' RLS, so PostgREST must
-- not see it at all); service_role is granted SELECT explicitly.

create table public.attendance_enrolments (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  employee_id uuid not null,
  valid       daterange not null check (not isempty(valid)),
  enabled_at  timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- AD-8: a new tracked period may not overlap the previous one.
  constraint attendance_enrolments_employee_valid_excl
    exclude using gist (employee_id with =, valid with &&)
);

-- The 15-5 hardening pattern: users carries UNIQUE (id, tenant_id)
-- (20260927000001), so the child FK pins the employee to the tenant.
alter table public.attendance_enrolments
  add constraint attendance_enrolments_employee_tenant_fkey
  foreign key (employee_id, tenant_id)
  references public.users (id, tenant_id) on delete restrict;

create table public.attendance_office_assignments (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  employee_id uuid not null,
  office_id   uuid not null,
  valid       daterange not null check (not isempty(valid)),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- FR-6: exactly one office assignment on any date (at-most-one half).
  constraint attendance_office_assignments_employee_valid_excl
    exclude using gist (employee_id with =, valid with &&)
);

alter table public.attendance_office_assignments
  add constraint attendance_office_assignments_employee_tenant_fkey
  foreign key (employee_id, tenant_id)
  references public.users (id, tenant_id) on delete restrict;

-- offices carries UNIQUE (id, tenant_id) since 20260926000007.
alter table public.attendance_office_assignments
  add constraint attendance_office_assignments_office_tenant_fkey
  foreign key (office_id, tenant_id)
  references public.attendance_offices (id, tenant_id) on delete restrict;

create table public.attendance_onboarding (
  employee_id  uuid primary key,
  tenant_id    uuid not null references public.tenants (id) on delete cascade,
  onboarded_at timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.attendance_onboarding
  add constraint attendance_onboarding_employee_tenant_fkey
  foreign key (employee_id, tenant_id)
  references public.users (id, tenant_id) on delete restrict;

alter table public.attendance_enrolments          enable row level security;
alter table public.attendance_office_assignments  enable row level security;
alter table public.attendance_onboarding          enable row level security;
-- No policies: deny-by-default (the admin client / pg service credentials
-- are the only writers).

create trigger set_updated_at_attendance_enrolments
  before update on public.attendance_enrolments
  for each row execute function public.update_updated_at_column();
create trigger set_updated_at_attendance_office_assignments
  before update on public.attendance_office_assignments
  for each row execute function public.update_updated_at_column();
create trigger set_updated_at_attendance_onboarding
  before update on public.attendance_onboarding
  for each row execute function public.update_updated_at_column();

-- ------------------------------------------------------------------
-- Coverage invariant (AD-8): internal trigger helper. Not callable,
-- no EXECUTE surface — schema plumbing, not an RPC.
-- ------------------------------------------------------------------
create or replace function public.attendance_enrolment_coverage_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_employee_id uuid;
  -- Finite stand-in for an unbounded range end: upper() of an unbounded
  -- daterange is NULL on PG17, and 'infinity'::date - date is an ERROR
  -- (22008) — day-span arithmetic must stay finite. No real enrolment
  -- ends on 9999-12-31. The CHECK constraints below ban an explicit
  -- 'infinity' upper so this sentinel can never be bypassed. (Review
  -- corrective applies folded into this file's final body: view grants,
  -- guard sentinel, deferred trigger timing, archived-history liveness.)
  v_open_end constant date := date '9999-12-31';
begin
  v_employee_id := coalesce(new.employee_id, old.employee_id);

  -- No assignment may reach outside an enrolment (checked first: the
  -- coverage half below assumes containment).
  if exists (
    select 1
    from public.attendance_office_assignments a
    where a.employee_id = v_employee_id
      and not exists (
        select 1
        from public.attendance_enrolments e
        where e.employee_id = a.employee_id
          and e.valid @> a.valid
      )
  ) then
    raise exception
      'employee % has an office assignment outside any enrolment',
      v_employee_id
      using errcode = '23514',
            hint = 'ATTENDANCE_ASSIGNMENT_GAP';
  end if;

  -- ALL periods (closed history included) must be covered by assignments —
  -- archived offices still cover the past they once served (FR-5). Coverage
  -- is EXACT ENDPOINT CHAINING: the first leg starts at the period start,
  -- every next leg starts where the previous ended, and the chain reaches
  -- the period's end (sentinel for open ranges) — a day-sum comparison
  -- cannot see gaps once both sides are infinite (review finding: a
  -- [today,∞) enrolment with only a [next-month,∞) leg summed to ∞ = ∞).
  -- upper() of an unbounded range is NULL on PG17, so open ends coalesce to
  -- the finite sentinel ('infinity'::date - date is an error, not integer
  -- arithmetic).
  if exists (
    select 1
    from public.attendance_enrolments e
    cross join lateral (
      with legs as (
        select lower(a.valid) as s,
               coalesce(upper(a.valid), v_open_end) as t,
               lag(coalesce(upper(a.valid), v_open_end)) over (order by lower(a.valid)) as prev_t
        from public.attendance_office_assignments a
        where a.employee_id = e.employee_id
          and a.valid <@ e.valid
      )
      select (select min(s) from legs) is distinct from lower(e.valid) as gap_start,
             coalesce((select bool_or(prev_t is not null and prev_t <> s) from legs), false) as gap_mid,
             (select max(t) from legs) is distinct from coalesce(upper(e.valid), v_open_end) as gap_end
    ) g
    where e.employee_id = v_employee_id
      and (g.gap_start or g.gap_mid or g.gap_end)
  ) then
    raise exception
      'employee % has an enrolled date without an office assignment',
      v_employee_id
      using errcode = '23514',
            hint = 'ATTENDANCE_ASSIGNMENT_GAP';
  end if;

  -- CURRENT-OR-FUTURE periods must be chained over LIVE assignments — an
  -- archived office can never serve a check-in. Closed history is exempt
  -- (previous check): after office A is archived, the employee can still
  -- be disabled, reassigned and re-enabled.
  if exists (
    select 1
    from public.attendance_enrolments e
    join public.users u on u.id = e.employee_id
    cross join lateral (
      with legs as (
        select lower(a.valid) as s,
               coalesce(upper(a.valid), v_open_end) as t,
               lag(coalesce(upper(a.valid), v_open_end)) over (order by lower(a.valid)) as prev_t
        from public.attendance_office_assignments a
        join public.attendance_offices o on o.id = a.office_id
        where a.employee_id = e.employee_id
          and o.archived_at is null
          and a.valid <@ e.valid
      )
      select (select min(s) from legs) is distinct from lower(e.valid) as gap_start,
             coalesce((select bool_or(prev_t is not null and prev_t <> s) from legs), false) as gap_mid,
             (select max(t) from legs) is distinct from coalesce(upper(e.valid), v_open_end) as gap_end
    ) g
    where e.employee_id = v_employee_id
      and coalesce(upper(e.valid), v_open_end) > public.attendance_today(u.tenant_id)
      and (g.gap_start or g.gap_mid or g.gap_end)
  ) then
    raise exception
      'employee % has a current or future enrolled date without a live office assignment',
      v_employee_id
      using errcode = '23514',
            hint = 'ATTENDANCE_ASSIGNMENT_GAP';
  end if;

  return null;
end;
$$;

revoke execute on function public.attendance_enrolment_coverage_guard()
  from public, anon, authenticated;

-- DEFERRABLE INITIALLY DEFERRED: the check runs at COMMIT, not per
-- statement — the lifecycle co-writes the enrolment and its assignment as
-- two statements inside one transaction, so IMMEDIATE would reject the
-- first statement of every legitimate enable. Broken paths fail the whole
-- transaction at COMMIT with the same 23514/ATTENDANCE_ASSIGNMENT_GAP.
create constraint trigger attendance_enrolment_coverage
  after insert or update or delete on public.attendance_enrolments
  deferrable initially deferred
  for each row
  execute function public.attendance_enrolment_coverage_guard();

create constraint trigger attendance_assignment_coverage
  after insert or update or delete on public.attendance_office_assignments
  deferrable initially deferred
  for each row
  execute function public.attendance_enrolment_coverage_guard();

-- ------------------------------------------------------------------
-- AD-17: the one access-state source. Read only via the admin client
-- (me/access, /users/me technician mirror) and the pg pool (owner roster).
-- ------------------------------------------------------------------
create view public.attendance_access_state
with (security_invoker = true) as
select
  u.id as user_id,
  u.tenant_id,
  -- FR-1/FR-3: the kill switch is the module's off act — no attendance UI
  -- for anyone while it is off; history rows are untouched.
  (coalesce(s.enabled, false) and s.setup_completed_at is not null)
    as attendance_enabled,
  case
    when coalesce(s.enabled, false) is false
      or s.setup_completed_at is null then 'none'
    when cur.period_start is not null then 'active'
    when nx.next_start is not null then 'upcoming'
    when past.seen is not null then 'history_only'
    else 'none'
  end as access_state,
  case
    when cur.period_start is not null then cur.period_start
    when nx.next_start is not null then nx.next_start
  end as attendance_start_date,
  cur.enabled_at as enabled_at,
  ob.onboarded_at,
  a.office_id,
  o.name as office_name
from public.users u
left join public.attendance_settings s
  on s.tenant_id = u.tenant_id
left join public.attendance_onboarding ob
  on ob.employee_id = u.id
-- The period covering today (active).
left join lateral (
  select e.employee_id, lower(e.valid) as period_start, e.enabled_at
  from public.attendance_enrolments e
  where e.employee_id = u.id
    and e.valid @> public.attendance_today(u.tenant_id)
  limit 1
) cur on true
-- The next tracked period's start (upcoming).
left join lateral (
  select min(lower(e.valid)) as next_start
  from public.attendance_enrolments e
  where e.employee_id = u.id
    and lower(e.valid) > public.attendance_today(u.tenant_id)
) nx on true
-- Any closed period (history_only).
left join lateral (
  select 1 as seen
  from public.attendance_enrolments e
  where e.employee_id = u.id
    and upper(e.valid) <= public.attendance_today(u.tenant_id)
  limit 1
) past on true
-- The live assignment covering the relevant date (today when active, the
-- next period's start when upcoming). Writes guarantee it exists; a gap
-- surfaces as a null office rather than a wrong one.
left join lateral (
  select a.office_id
  from public.attendance_office_assignments a
  where a.employee_id = u.id
    and a.valid @> coalesce(
      cur.period_start,
      nx.next_start,
      public.attendance_today(u.tenant_id))
  limit 1
) a on true
left join public.attendance_offices o
  on o.id = a.office_id and o.archived_at is null
-- Tenant-qualified rows only: users.tenant_id is deliberately nullable
-- (pre-setup owners) and attendance_today(NULL) would raise. (Review
-- hardening; security_invoker above keeps the view behind the base tables'
-- RLS even if a future grant re-opens it.)
where u.tenant_id is not null;

-- Deny-by-default on the view (corrective apply fix_15_7_view_grants made
-- this REVOKE ALL live: Supabase's default privileges grant every
-- table privilege to anon/authenticated/service_role at creation, so a
-- plain `revoke select` leaves inert write grants behind).
revoke all on public.attendance_access_state
  from anon, authenticated, service_role;
grant select on public.attendance_access_state to service_role;

-- Review hardening (corrective apply fix_15_7_review_criticals):
-- open ranges must use a NULL upper (the coverage guard's sentinel assumes
-- it; an explicit 'infinity' upper would bypass the coalesce), the
-- blocker/fan-out joins get an office_id index, and the three tables lose
-- their inert anon/authenticated default grants (RLS no-policies already
-- denies; grants hygiene matches the view).
alter table public.attendance_enrolments
  add constraint attendance_enrolments_valid_open_end_check
  check (upper(valid) is null or upper(valid) < 'infinity'::date);
alter table public.attendance_office_assignments
  add constraint attendance_office_assignments_valid_open_end_check
  check (upper(valid) is null or upper(valid) < 'infinity'::date);

create index attendance_office_assignments_office_id_idx
  on public.attendance_office_assignments (office_id);

revoke all on public.attendance_enrolments,
  public.attendance_office_assignments,
  public.attendance_onboarding
  from anon, authenticated;
