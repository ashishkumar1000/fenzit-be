-- Story 15-3 (Epic 15): Offices & office rules — tables.
-- attendance_offices: an Office holds the location and the timing rules
--   (FR-5). Pin and radius are NOT effective-dated (AD-8 adopted wording) —
--   plain columns on the row. Offices are archived, never deleted (AD-25).
-- attendance_office_rules: the effective-dated timing/hours rules
--   (AD-8) — start/end TIME, late cut-off, full/half-day hours. The EXCLUDE
--   gist constraint makes two rules active on one date impossible (NFR-4);
--   btree_gist is what lets the EXCLUDE mix an equality key (office_id) with
--   a range key (valid).
-- Names are unique per tenant (user decision 2026-09-26, case-insensitive) —
--   owner-typed duplicates like "Thane Office"/"thane office" must not both
--   exist. The index is the single guard; no DTO case-folding.

create extension if not exists btree_gist;

create table public.attendance_offices (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  name       text not null,
  latitude   double precision not null check (latitude between -90 and 90),
  longitude  double precision not null check (longitude between -180 and 180),
  radius_m   integer not null check (radius_m between 50 and 1000),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Case-insensitive unique name per tenant. Expressed as a unique index —
-- Postgres has no table-constraint syntax for an expression key.
create unique index attendance_offices_tenant_name_unique
  on public.attendance_offices (tenant_id, lower(name));

create table public.attendance_office_rules (
  id                  uuid primary key default gen_random_uuid(),
  office_id           uuid not null references public.attendance_offices(id) on delete restrict,
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  valid               daterange not null check (not isempty(valid)),
  start_time          time not null,
  end_time            time not null check (end_time > start_time),
  late_cutoff_minutes integer not null check (late_cutoff_minutes between 0 and 120),
  full_day_hours      numeric(4, 2) not null check (full_day_hours > 0),
  half_day_hours      numeric(4, 2) not null check (half_day_hours > 0 and half_day_hours < full_day_hours),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint attendance_office_rules_no_overlap
    exclude using gist (office_id with =, valid with &&)
);

-- rules → offices is ON DELETE RESTRICT: history is never cascaded away, and
-- offices are archived (AD-25) so the restrict never fires in practice — it
-- only guards against accidental office deletion.

-- Deny-by-default (the 15-2 review decision): RLS enabled with NO policies —
-- no authenticated JWT gets direct PostgREST access; every read/write routes
-- through the NestJS admin client (which bypasses RLS) with an explicit
-- tenant_id filter on top.
alter table public.attendance_offices enable row level security;
alter table public.attendance_office_rules enable row level security;

create trigger attendance_offices_updated_at
  before update on public.attendance_offices
  for each row execute function public.update_updated_at_column();

create trigger attendance_office_rules_updated_at
  before update on public.attendance_office_rules
  for each row execute function public.update_updated_at_column();