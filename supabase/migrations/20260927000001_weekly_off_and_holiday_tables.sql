-- Story 15-5 (Epic 15): Weekly offs & holidays — storage tables.
-- attendance_weekly_off_defaults: the tenant's weekly-off days, effective-dated
--   (AD-8). NO row = all 7 days are working days; "the default is Sunday"
--   (FR-18) is an FE preselection, never a DB seed — the wizard (15-6/15-8)
--   saves Sunday as the first real row.
-- attendance_weekly_off_overrides: a per-employee weekly off that REPLACES the
--   tenant default while its validity range covers the date (AD-22). An empty
--   days array = "works all 7 days" — the only way to express "tenant has a
--   weekly off but this employee works that day". Removing the override is a
--   separate operation (the row goes; the default resumes).
-- holidays: tenant-wide dates nobody checks in (FR-20). UNIQUE (tenant_id,
--   holiday_date); date is immutable (impact/notifications differ per date) —
--   a date change is remove + add. Past dates allowed; day statuses recompute
--   on read (AD-10). No soft delete — removal is a hard delete.
--
-- days is INTEGER[] of ISO weekday numbers (1=Mon .. 7=Sun). The DB CHECKs
-- are the authority (NFR-4): elements must be weekdays and at least one
-- working day must remain (cardinality < 7 — FR-18's zero-working-days rule).
-- The DTO mirrors them for a pre-DB 422. Sorting/dedup is the RPC's job.
--
-- Deny-by-default (15-2 review decision): RLS enabled with NO policies on
-- all three tables — every read/write routes through the NestJS admin client
-- with an explicit tenant_id filter. AD-8 exclusion constraints
-- (btree_gist, enabled by 15-3's 20260926000005) keep each owner's ranges
-- non-overlapping; the shared clip/delete/insert algorithm lives in the RPCs
-- (20260927000002).
--
-- 15-3 review hardening mirrored: UNIQUE (id, tenant_id) on users gives the
-- overrides' composite FK a matching target, so an override row's tenant_id
-- can never disagree with its employee's tenant — history is never cascaded
-- (ON DELETE RESTRICT).

create table public.attendance_weekly_off_defaults (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  valid      daterange not null constraint attendance_weekly_off_defaults_valid_not_empty
             check (not isempty(valid)),
  days       integer[] not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint attendance_weekly_off_defaults_days_range
    check (days <@ array[1, 2, 3, 4, 5, 6, 7]),
  constraint attendance_weekly_off_defaults_days_has_working_day
    check (cardinality(days) < 7),

  constraint attendance_weekly_off_defaults_tenant_valid_excl
    exclude using gist (tenant_id with =, valid with &&)
);

-- Composite-FK target for the overrides table (15-3's 20260926000007
-- pattern). users.tenant_id stays nullable (owners before company setup) —
-- id being the primary key keeps (id, tenant_id) unique regardless. Must
-- exist BEFORE attendance_weekly_off_overrides references it.
alter table public.users
  add constraint users_id_tenant_id_key unique (id, tenant_id);

create table public.attendance_weekly_off_overrides (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  employee_id uuid not null,
  valid       daterange not null constraint attendance_weekly_off_overrides_valid_not_empty
              check (not isempty(valid)),
  days        integer[] not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint attendance_weekly_off_overrides_days_range
    check (days <@ array[1, 2, 3, 4, 5, 6, 7]),
  constraint attendance_weekly_off_overrides_days_has_working_day
    check (cardinality(days) < 7),

  -- Keyed on employee_id alone: an employee belongs to exactly one tenant,
  -- so this also scopes the tenant. The composite FK below pins tenant_id.
  constraint attendance_weekly_off_overrides_employee_valid_excl
    exclude using gist (employee_id with =, valid with &&),

  constraint attendance_weekly_off_overrides_employee_tenant_fkey
    foreign key (employee_id, tenant_id)
    references public.users (id, tenant_id)
    on delete restrict
);

create table public.holidays (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  holiday_date date not null,
  name        text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint holidays_tenant_date_key unique (tenant_id, holiday_date)
);

alter table public.attendance_weekly_off_defaults enable row level security;
alter table public.attendance_weekly_off_overrides enable row level security;
alter table public.holidays enable row level security;
-- Deliberately no policies: deny-by-default. All access goes through the
-- NestJS admin client with explicit tenant_id filters (AD-3).

create trigger attendance_weekly_off_defaults_updated_at
  before update on public.attendance_weekly_off_defaults
  for each row execute function public.update_updated_at_column();

create trigger attendance_weekly_off_overrides_updated_at
  before update on public.attendance_weekly_off_overrides
  for each row execute function public.update_updated_at_column();

create trigger holidays_updated_at
  before update on public.holidays
  for each row execute function public.update_updated_at_column();