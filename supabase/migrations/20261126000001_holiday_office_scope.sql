-- Holidays: per-office applicability (console redesign 2026-11-26, spec
-- holidays-console-redesign-2026-11-26). DDL only — zero functions and zero
-- triggers (services stamp updated_at); deny-by-default RLS with
-- service_role-only grants (house idiom, payroll style).
--
-- scope: 'all' = every office (the tenant-wide behaviour every existing row
-- keeps); 'offices' = closed only for the offices joined in holiday_offices.
-- The (tenant_id, holiday_date) unique stays — one holiday per date, the
-- applicability rides on the same row. No backfill needed: every existing
-- row defaults to 'all'.

alter table public.holidays
  add column description text;

alter table public.holidays
  add column scope text not null default 'all',
  add constraint holidays_scope_check check (scope in ('all', 'offices'));

create table public.holiday_offices (
  holiday_id uuid not null references public.holidays (id) on delete cascade,
  office_id  uuid not null,
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  primary key (holiday_id, office_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Composite FK: a holiday can never attach another tenant's office
-- (attendance_offices already carries unique (id, tenant_id)).
alter table public.holiday_offices
  add constraint holiday_offices_office_tenant_fkey
  foreign key (office_id, tenant_id)
    references public.attendance_offices (id, tenant_id) on delete cascade;

create index holiday_offices_office_idx on public.holiday_offices (office_id);

alter table public.holiday_offices enable row level security;

revoke all on public.holiday_offices from public, anon, authenticated;

grant select, insert, update, delete on public.holiday_offices to service_role;
