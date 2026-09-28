-- Stories 17-1..17-4 (Epic 17): Leave Management — storage tables.
--
-- leave_requests: one row per request — the range, the half-day part, the
--   reason, created_by and request_id (AD-11). UNIQUE (tenant_id, request_id)
--   is AD-6's idempotency guarantee for apply / apply-on-behalf (the
--   X-Idempotency-Key): a replay reads the stored request and writes nothing.
--
-- leave_request_days: one row per calendar date in the range INCLUDING off
--   days (weekly offs / holidays inside the span) — the days carry the span;
--   the working-day count excludes them on read. State machine:
--   pending → approved|rejected|cancelled; approved → revoked|cancelled
--   (AD-11), guarded by the leave_request_days_state_guard() trigger — the
--   ONE new stored function this epic adds (AD-3 amendment justification:
--   AD-11 explicitly mandates "a trigger guard rejects illegal transitions",
--   and the machine must hold for every writer, including future cron/manual
--   paths, not only the TypeScript one). The partial unique index on
--   (employee_id, leave_date) WHERE state IN ('pending','approved') blocks
--   overlapping active leave. Rows are never hard-deleted (request FK is
--   RESTRICT); tenant drops cascade via each table's own tenant_id FK.
--
-- leave_events: the AD-23 audit — one row per transition call (cause, actor,
--   reason, affected dates). seq (identity) orders "last event" for the
--   AD-6 same-actor retry rule (uuid + now() cannot break ties).
--
-- NO other functions and no RPCs (user decision 2026-09-27/28, AD-3
-- amendment: Epics 16-19 are NestJS-first). Every state change goes through
-- src/attendance/leave-transition.ts inside the caller's pg transaction,
-- reusing the existing attendance_lock_tenant / attendance_lock_employee /
-- attendance_today helpers from 20260926000003.
--
-- Access (15-7/16-1 grants hygiene): RLS enabled with NO policies — deny by
-- default; Supabase's default privileges would hand anon/authenticated inert
-- table grants at creation, so REVOKE ALL clears them and only service_role
-- is granted the privileges the backend uses.

create table public.leave_requests (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  employee_id uuid not null,
  request_id  uuid not null,
  start_date  date not null,
  end_date    date not null,
  part        text not null,
  reason      text not null,
  created_by  uuid not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint leave_requests_part_check check (part = any (array[
    'full_day'::text, 'first_half'::text, 'second_half'::text])),
  constraint leave_requests_span_check check (end_date >= start_date),
  constraint leave_requests_reason_len_check
    check (char_length(reason) between 1 and 500),
  constraint leave_requests_tenant_request_uq unique (tenant_id, request_id)
);

-- composite tenant FKs (15-7 pattern): people cannot be orphaned across tenants
alter table public.leave_requests
  add constraint leave_requests_employee_tenant_fkey
  foreign key (employee_id, tenant_id)
  references public.users (id, tenant_id) on delete restrict;
alter table public.leave_requests
  add constraint leave_requests_created_by_tenant_fkey
  foreign key (created_by, tenant_id)
  references public.users (id, tenant_id) on delete restrict;

create index leave_requests_employee_created_idx
  on public.leave_requests (employee_id, created_at desc);
create index leave_requests_tenant_created_idx
  on public.leave_requests (tenant_id, created_at desc);

create table public.leave_request_days (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants (id) on delete cascade,
  leave_request_id uuid not null references public.leave_requests (id),
  employee_id      uuid not null,
  leave_date       date not null,
  state            text not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint leave_request_days_state_check check (state = any (array[
    'pending'::text, 'approved'::text, 'rejected'::text,
    'cancelled'::text, 'revoked'::text])),
  constraint leave_request_days_request_date_uq unique (leave_request_id, leave_date)
);

-- AD-11: leave rows are never hard-deleted with their request; tenant drops
-- cascade via tenant_id above.
alter table public.leave_request_days
  add constraint leave_request_days_request_fkey
  foreign key (leave_request_id)
  references public.leave_requests (id) on delete restrict;
alter table public.leave_request_days
  add constraint leave_request_days_employee_tenant_fkey
  foreign key (employee_id, tenant_id)
  references public.users (id, tenant_id) on delete restrict;

create index leave_request_days_employee_date_idx
  on public.leave_request_days (employee_id, leave_date);
create index leave_request_days_request_idx
  on public.leave_request_days (leave_request_id);

-- AD-11 overlap blocker: at most one ACTIVE (pending/approved) leave day per
-- employee per date. A raced apply INSERT fails here with 23505 naming this
-- index — the repository maps it to LEAVE_OVERLAP.
create unique index leave_request_days_active_uq
  on public.leave_request_days (employee_id, leave_date)
  where state in ('pending','approved');

create table public.leave_events (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants (id) on delete cascade,
  leave_request_id uuid not null references public.leave_requests (id),
  employee_id      uuid not null,
  cause            text not null,
  actor_id         uuid,
  reason           text,
  affected_dates   date[] not null default '{}',
  seq              bigint generated always as identity,
  created_at       timestamptz not null default now(),

  constraint leave_events_cause_check check (cause = any (array[
    'apply'::text, 'apply_on_behalf'::text, 'approve'::text, 'reject'::text,
    'employee_cancel'::text, 'owner_revoke'::text, 'checkin_auto_cancel'::text,
    'disable'::text, 'removal'::text]))
);

alter table public.leave_events
  add constraint leave_events_employee_tenant_fkey
  foreign key (employee_id, tenant_id)
  references public.users (id, tenant_id) on delete restrict;
alter table public.leave_events
  add constraint leave_events_actor_tenant_fkey
  foreign key (actor_id, tenant_id)
  references public.users (id, tenant_id) on delete restrict;

alter table public.leave_events
  add constraint leave_events_request_fkey
  foreign key (leave_request_id)
  references public.leave_requests (id) on delete restrict;

create index leave_events_request_seq_idx
  on public.leave_events (leave_request_id, seq desc);

-- AD-11 transition guard: same→same is a no-op; pending goes to
-- approved/rejected/cancelled; approved goes to revoked/cancelled.
-- rejected/cancelled/revoked are terminal. The HINT names the ErrorCode the
-- service maps (PT-style convention, house vocabulary).
create function public.leave_request_days_state_guard()
returns trigger
language plpgsql
as $$
begin
  if new.state = old.state then
    return new;
  end if;
  if old.state = 'pending' and new.state in ('approved','rejected','cancelled') then
    return new;
  end if;
  if old.state = 'approved' and new.state in ('revoked','cancelled') then
    return new;
  end if;
  raise exception
    'Illegal leave day transition % -> %', old.state, new.state
    using errcode = 'PT422', hint = 'LEAVE_INVALID_TRANSITION';
end;
$$;

create trigger leave_request_days_state_guard_trigger
  before update of state on public.leave_request_days
  for each row execute function public.leave_request_days_state_guard();

-- updated_at maintenance (house trigger, reused verbatim)
create trigger leave_requests_updated_at before update on public.leave_requests
  for each row execute function public.update_updated_at_column();
create trigger leave_request_days_updated_at before update on public.leave_request_days
  for each row execute function public.update_updated_at_column();

-- Deny-by-default (15-7 hygiene): Supabase grants tables to anon/authenticated
-- at creation; clear them, grant service_role only. The guard function gets
-- EXECUTE revoked from PUBLIC/anon/authenticated too (the pg_proc
-- ^(attendance|leave)_ scan in rls-isolation.integration.spec.ts asserts it).
alter table public.leave_requests     enable row level security;
alter table public.leave_request_days enable row level security;
alter table public.leave_events       enable row level security;

revoke all on public.leave_requests     from public, anon, authenticated;
revoke all on public.leave_request_days from public, anon, authenticated;
revoke all on public.leave_events       from public, anon, authenticated;
revoke all on function public.leave_request_days_state_guard()
  from public, anon, authenticated;

grant select, insert, update on public.leave_requests     to service_role;
grant select, insert, update on public.leave_request_days to service_role;
grant select, insert          on public.leave_events      to service_role;
