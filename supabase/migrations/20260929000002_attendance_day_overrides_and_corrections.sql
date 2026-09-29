-- Stories 18-1 + 18-2 (Epic 18): Day-statuses & Attendance corrections —
-- storage.
--
-- attendance_day_overrides: the AD-12 correction sink — one ACTIVE row per
--   (employee_id, work_date). Either a status correction ('present' |
--   'half_day' | 'absent', status-only short-circuit in FR-10 rule 1) or
--   manual instants (times-only — the row substitutes the day's check-in/out
--   instants and evaluation CONTINUES through rules 2-10), never both (the
--   API is XOR; the DB CHECKs the content/pair rules). The ORIGINAL
--   attendance_records row is never touched (AD-12).
--   Removal (FR-21 "Owner can correct it again" / the recompute-live
--   contract) is a SOFT DELETE on the row's deleted_at; the write path only
--   ever UPSERTS (ON CONFLICT (employee_id, work_date)), so the same
--   physical row is marked and un-marked — never a second row. A plain
--   unique index on (employee_id, work_date) is therefore both the one
--   guard the audit FK needs (a composite FK cannot reference a partial
--   index) and sufficient; spec D1's partial index variant is impossible
--   with the RESTRICT FK and is superseded here (upsert-and-undelete keeps
--   the audit chain intact).
--
-- attendance_corrections: the FR-21 audit, append-only — actor (owner only),
--   note (1-500), old/new value JSON. seq (identity) orders a per-date chain
--   for the expandable history; the chain grows unboundedly by repeat
--   corrections — that is the FR-21 contract, cursor-paginated on read.
--
-- attendance_attempts.acknowledged_at: AD-10's marker lifecycle — the
--   fake_location_attempt marker clears when unacknowledged mocked attempts
--   are acknowledged; attempt rows stay (the dispute view, AD-4).
--
-- NO new functions, triggers beyond updated_at, or RPCs (AD-3 amendment:
-- Epics 16-19 are NestJS-first). Writes are single pg transactions in
-- fenzit-be (src/attendance/corrections.*.ts) reusing the existing
-- attendance_lock_employee helper; reads are batched parameterised SQL in
-- src/attendance/day-status.read.ts.
--
-- Access (15-7/16-1 grants hygiene): RLS enabled with NO policies — deny by
-- default; Supabase's default privileges would hand anon/authenticated inert
-- table grants at creation, so REVOKE ALL clears them and only service_role
-- is granted the privileges the backend uses.

create table public.attendance_day_overrides (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants (id) on delete cascade,
  employee_id        uuid not null,
  work_date          date not null,
  -- present | half_day | absent; null = times-only correction (manual instants)
  status             text,
  manual_checkin_at  timestamptz,
  manual_checkout_at timestamptz,
  -- soft delete (the removal path): reads filter it out; audit FK untouched
  deleted_at         timestamptz,
  created_by         uuid not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint attendance_day_overrides_status_check
    check (status = any (array[
      'present'::text, 'half_day'::text, 'absent'::text])),
  constraint attendance_day_overrides_has_value_check
    check (status is not null or manual_checkin_at is not null
           or manual_checkout_at is not null),
  constraint attendance_day_overrides_time_order_check
    check (manual_checkout_at is null or manual_checkin_at is null
           or manual_checkout_at > manual_checkin_at)
);

alter table public.attendance_day_overrides
  add constraint attendance_day_overrides_empdate_uq
  unique (employee_id, work_date);

alter table public.attendance_day_overrides
  add constraint attendance_day_overrides_employee_tenant_fkey
  foreign key (employee_id, tenant_id)
  references public.users (id, tenant_id) on delete restrict;
alter table public.attendance_day_overrides
  add constraint attendance_day_overrides_created_by_tenant_fkey
  foreign key (created_by, tenant_id)
  references public.users (id, tenant_id) on delete restrict;

create index attendance_day_overrides_tenant_date_idx
  on public.attendance_day_overrides (tenant_id, employee_id, work_date);

create table public.attendance_corrections (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  employee_id uuid not null,
  work_date   date not null,
  actor_id    uuid not null,
  note        text not null,
  old_value   jsonb not null,
  new_value   jsonb not null,
  seq         bigint generated always as identity,
  created_at  timestamptz not null default now(),

  constraint attendance_corrections_note_check
    check (char_length(note) between 1 and 500)
);

alter table public.attendance_corrections
  add constraint attendance_corrections_employee_tenant_fkey
  foreign key (employee_id, tenant_id)
  references public.users (id, tenant_id) on delete restrict;
alter table public.attendance_corrections
  add constraint attendance_corrections_actor_tenant_fkey
  foreign key (actor_id, tenant_id)
  references public.users (id, tenant_id) on delete restrict;
-- The override a correction refers to is never hard-deleted (overrides are
-- only upserted), so this RESTRICT chain can never fire.
alter table public.attendance_corrections
  add constraint attendance_corrections_override_fkey
  foreign key (employee_id, work_date)
  references public.attendance_day_overrides (employee_id, work_date)
  on delete restrict;

create index attendance_corrections_emp_date_seq_idx
  on public.attendance_corrections (employee_id, work_date, seq desc);
create index attendance_corrections_created_idx
  on public.attendance_corrections (tenant_id, created_at desc, id desc);

alter table public.attendance_attempts
  add column acknowledged_at timestamptz;  -- null = not yet acknowledged

-- updated_at maintenance (house trigger, reused verbatim)
create trigger attendance_day_overrides_updated_at
  before update on public.attendance_day_overrides
  for each row execute function public.update_updated_at_column();
alter table public.attendance_day_overrides enable row level security;
alter table public.attendance_corrections   enable row level security;

revoke all on public.attendance_day_overrides from public, anon, authenticated;
revoke all on public.attendance_corrections   from public, anon, authenticated;

grant select, insert, update          on public.attendance_day_overrides to service_role;
grant select, insert                  on public.attendance_corrections   to service_role;
grant select, update on public.attendance_attempts to service_role;
