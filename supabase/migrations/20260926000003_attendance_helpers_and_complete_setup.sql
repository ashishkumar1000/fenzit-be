-- Story 15-2 (Epic 15): Attendance module foundation — shared helpers and
-- the setup-completion RPC.
-- attendance_today(p_tenant_id): the ONLY source of "today" in attendance
--   code (AD-7) — server clock rendered in the tenant's timezone.
-- attendance_lock_tenant / attendance_lock_employee: the two advisory-lock
--   wrappers every attendance/leave RPC serialises through (AD-5). Keys come
--   only from these helpers, via distinct text prefixes into
--   hashtextextended, so a tenant id and an employee id can never collide on
--   the same lock slot.
-- attendance_complete_setup: FR-1 gate. Ships before the offices (15-3) and
--   enrolment/assignment (15-7) tables exist — PL/pgSQL bodies are validated
--   lazily, so this migration applies cleanly and the function becomes
--   callable once those stories land. Its real-DB gating probes belong to
--   15-7.
--
-- AD-3: every function here is SECURITY DEFINER SET search_path = public
-- with EXECUTE revoked from PUBLIC, anon, authenticated and granted to
-- service_role, in this same file.

-- Fails loud on an unknown tenant (review 2026-09-26): the single source of
-- "today" must never hand a silent NULL into downstream date maths.
create or replace function public.attendance_today(p_tenant_id uuid)
returns date
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tz text;
begin
  select timezone into v_tz from public.tenants where id = p_tenant_id;
  if v_tz is null then
    raise exception 'tenant % not found', p_tenant_id
      using errcode = 'PT404',
            hint = 'ATTENDANCE_TENANT_NOT_FOUND';
  end if;
  return (now() at time zone v_tz)::date;
end;
$$;

-- pg_advisory_xact_lock[_shared](bigint) per AD-5 — this database exposes
-- the shared variant as a distinct pg_advisory_xact_lock_shared function
-- (no two-arg boolean overload), verified live 2026-09-26.
create or replace function public.attendance_lock_tenant(
  p_tenant_id uuid,
  p_exclusive boolean
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  -- A NULL p_exclusive silently taking a shared lock would be a quiet
  -- correctness bug in a future caller — fail loud instead.
  if p_exclusive is true then
    perform pg_advisory_xact_lock(hashtextextended('tenant:' || p_tenant_id::text, 0));
  elsif p_exclusive is false then
    perform pg_advisory_xact_lock_shared(hashtextextended('tenant:' || p_tenant_id::text, 0));
  else
    raise exception 'p_exclusive must be true or false'
      using errcode = 'PT400',
            hint = 'VALIDATION_ERROR';
  end if;
end;
$$;

create or replace function public.attendance_lock_employee(p_employee_id uuid)
returns void
language sql
volatile
security definer
set search_path = public
as $$
  select pg_advisory_xact_lock(hashtextextended('employee:' || p_employee_id::text, 0));
$$;

create or replace function public.attendance_complete_setup(
  p_tenant_id uuid,
  p_actor_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_today date;
begin
  -- Tenant-wide RPC: exclusive tenant lock first (AD-5). No employee rows
  -- are changed here, so no employee locks.
  perform public.attendance_lock_tenant(p_tenant_id, true);

  -- Setup must have started and not already be completed.
  if not exists (
    select 1 from public.attendance_settings
    where tenant_id = p_tenant_id and setup_completed_at is null
  ) then
    raise exception 'attendance setup for tenant % not in progress', p_tenant_id
      using errcode = 'PT409',
            hint = 'ATTENDANCE_SETUP_ALREADY_COMPLETED';
  end if;

  v_today := public.attendance_today(p_tenant_id);

  -- Gate 1: at least one active office.
  -- Table arrives with Story 15-3.
  if not exists (
    select 1 from public.attendance_offices o
    where o.tenant_id = p_tenant_id
      and o.archived_at is null
  ) then
    raise exception 'tenant % has no active office', p_tenant_id
      using errcode = 'PT422',
            hint = 'ATTENDANCE_SETUP_INCOMPLETE';
  end if;

  -- Gate 2: at least one tracked employee whose office assignment covers
  -- today. Enrolment/assignment tables and their effective-dated shapes
  -- arrive with Story 15-7 — the enabled_at/valid predicates are written to
  -- the AD-8 declarations and are reconciled there.
  if not exists (
    select 1
    from public.attendance_enrolments e
    join public.users u on u.id = e.employee_id
    join public.attendance_office_assignments a on a.employee_id = e.employee_id
    where u.tenant_id = p_tenant_id
      and e.enabled_at is not null
      and e.valid @> v_today
      and a.valid @> v_today
  ) then
    raise exception 'tenant % has no tracked employee with an office assignment', p_tenant_id
      using errcode = 'PT422',
            hint = 'ATTENDANCE_SETUP_INCOMPLETE';
  end if;

  -- Completing setup turns the module on (PRD: the wizard IS the enable
  -- act); enabled=false remains the kill switch from then on.
  update public.attendance_settings
    set setup_completed_at = now(),
        enabled = true
    where tenant_id = p_tenant_id;
end;
$$;

revoke execute on function public.attendance_today(uuid)
  from public, anon, authenticated;
revoke execute on function public.attendance_lock_tenant(uuid, boolean)
  from public, anon, authenticated;
revoke execute on function public.attendance_lock_employee(uuid)
  from public, anon, authenticated;
revoke execute on function public.attendance_complete_setup(uuid, uuid)
  from public, anon, authenticated;

grant execute on function public.attendance_today(uuid) to service_role;
grant execute on function public.attendance_lock_tenant(uuid, boolean) to service_role;
grant execute on function public.attendance_lock_employee(uuid) to service_role;
grant execute on function public.attendance_complete_setup(uuid, uuid) to service_role;