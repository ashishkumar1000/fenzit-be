-- Story 15-2 (Epic 15): Attendance module foundation — settings & wizard
-- progress tables.
-- attendance_settings: per-tenant module state (AD-25). enabled is the
--   kill switch; setup_completed_at is set by attendance_complete_setup.
-- attendance_setup_progress: the FR-1 setup wizard's current step. Step
--   vocabulary is fixed (offices → timings → weekly_off → holidays →
--   employees); the FE advances the marker, the DB pins the vocabulary.
-- Both rows are created on demand (upsert when the wizard starts) — existing
-- tenants get no row until setup begins.

create table public.attendance_settings (
  tenant_id          uuid primary key references public.tenants(id) on delete cascade,
  enabled            boolean not null default false,
  setup_completed_at timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table public.attendance_setup_progress (
  tenant_id    uuid primary key references public.tenants(id) on delete cascade,
  current_step text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint attendance_setup_progress_step_check
    check (current_step = any (array[
      'offices'::text, 'timings'::text, 'weekly_off'::text,
      'holidays'::text, 'employees'::text
    ]))
);

-- Deny-by-default (review decision 2026-09-26): RLS enabled with NO
-- policies — these tables hold module state (the enabled kill switch and
-- setup_completed_at), so no authenticated JWT gets direct PostgREST access
-- at all; every read/write routes through the NestJS admin client (which
-- bypasses RLS) with an explicit tenant_id filter on top. Self-enabling the
-- module or faking completion without the attendance_complete_setup gates is
-- therefore impossible.
alter table public.attendance_settings enable row level security;
alter table public.attendance_setup_progress enable row level security;

create trigger attendance_settings_updated_at
  before update on public.attendance_settings
  for each row execute function public.update_updated_at_column();

create trigger attendance_setup_progress_updated_at
  before update on public.attendance_setup_progress
  for each row execute function public.update_updated_at_column();