-- Story 15-3 (Epic 15): Offices & office rules — lifecycle RPCs and the
-- archive-blockers preview.
-- attendance_create_office: two row-sets (office + initial rule), one RPC
--   (AD-3). The initial rule is valid [today, ∞) — "today" only from
--   attendance_today (AD-7). No tenant lock: a brand-new office has no
--   range set to serialise against.
-- attendance_update_office_rules: the shared AD-8 algorithm —
--   effective_from = tomorrow; delete the office's ranges starting on/after
--   effective_from; clip the covering range's upper bound to effective_from;
--   insert the new open range. Past dates keep the rule active on that date.
-- attendance_archive_office: exclusive tenant lock (AD-25); blocked by
--   tracked employees with current or future assignments; archived_at, never
--   a delete. Already-archived → idempotent no-op.
-- attendance_office_archive_blockers: the AD-24 read/preview the archive
--   write and the GET preview route share.
-- The blocker queries reference the enrolment/assignment tables that arrive
-- with Story 15-7 — PL/pgSQL bodies are validated lazily, so this migration
-- applies cleanly and the two functions become callable then (the
-- attendance_complete_setup precedent from 15-2). Their real-DB probes
-- belong to 15-7.
--
-- AD-3: every function here is SECURITY DEFINER SET search_path = public
-- with EXECUTE revoked from PUBLIC, anon, authenticated and granted to
-- service_role, in this same file.

-- Returns the new office id. DB CHECK constraints (radius/hours/time) are
-- the final range guard — the service maps 23514 → 422. The tenant/name
-- unique index (23505) is re-raised as PT409.
create or replace function public.attendance_create_office(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_name text,
  p_latitude double precision,
  p_longitude double precision,
  p_radius_m integer,
  p_start_time time,
  p_end_time time,
  p_late_cutoff_minutes integer,
  p_full_day_hours numeric,
  p_half_day_hours numeric
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_office_id uuid;
  v_today     date;
begin
  v_today := public.attendance_today(p_tenant_id);

  insert into public.attendance_offices (tenant_id, name, latitude, longitude, radius_m)
    values (p_tenant_id, p_name, p_latitude, p_longitude, p_radius_m)
    returning id into v_office_id;

  insert into public.attendance_office_rules
    (office_id, tenant_id, valid, start_time, end_time,
     late_cutoff_minutes, full_day_hours, half_day_hours)
    values (
      v_office_id,
      p_tenant_id,
      daterange(v_today, null, '[)'),
      p_start_time,
      p_end_time,
      p_late_cutoff_minutes,
      p_full_day_hours,
      p_half_day_hours
    );

  return v_office_id;
exception
  when unique_violation then
    raise exception 'an office named % already exists in tenant %', p_name, p_tenant_id
      using errcode = 'PT409',
            hint = 'ATTENDANCE_OFFICE_NAME_TAKEN';
end;
$$;

-- Rules edits serialise on the exclusive tenant lock: the algorithm mutates
-- the office's whole range set, and a concurrent edit would otherwise race
-- between the delete/clip/insert steps.
create or replace function public.attendance_update_office_rules(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_office_id uuid,
  p_start_time time,
  p_end_time time,
  p_late_cutoff_minutes integer,
  p_full_day_hours numeric,
  p_half_day_hours numeric
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_today           date;
  v_effective_from  date;
begin
  perform public.attendance_lock_tenant(p_tenant_id, true);

  v_today := public.attendance_today(p_tenant_id);
  -- AD-8: rule changes apply from tomorrow — today and all past dates keep
  -- the rule active on that date.
  v_effective_from := v_today + 1;

  if not exists (
    select 1 from public.attendance_offices
    where id = p_office_id
      and tenant_id = p_tenant_id
      and archived_at is null
  ) then
    raise exception 'office % not found in tenant %', p_office_id, p_tenant_id
      using errcode = 'PT404',
            hint = 'ATTENDANCE_OFFICE_NOT_FOUND';
  end if;

  -- Step 2: drop this office's ranges that start on or after effective_from
  -- (a second same-day edit replaces the earlier future range — no zombie
  -- future rules, per AD-8).
  delete from public.attendance_office_rules
    where office_id = p_office_id
      and lower(valid) >= v_effective_from;

  -- Step 3: clip the covering range (its upper bound may be infinity) to
  -- effective_from. Ranges that ended before effective_from don't contain
  -- it and are left alone.
  update public.attendance_office_rules
    set valid = daterange(lower(valid), v_effective_from, '[)')
    where office_id = p_office_id
      and valid @> v_effective_from;

  -- Step 4: the new rule, open-ended from tomorrow.
  insert into public.attendance_office_rules
    (office_id, tenant_id, valid, start_time, end_time, late_cutoff_minutes, full_day_hours, half_day_hours)
    values (
      p_office_id,
      p_tenant_id,
      daterange(v_effective_from, null, '[)'),
      p_start_time,
      p_end_time,
      p_late_cutoff_minutes,
      p_full_day_hours,
      p_half_day_hours
    );
end;
$$;

-- AD-25: archive runs under the exclusive tenant lock and is blocked by
-- current or future assignments of tracked employees. The blocker check
-- queries the 15-7 tables (attendance_enrolments / attendance_office_assignments)
-- which do not exist yet — the body is lazily validated and the call fails
-- loud (42P01) until 15-7 lands. Blockers travel via
-- attendance_office_archive_blockers (see below), not through this raise.
create or replace function public.attendance_archive_office(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_office_id uuid
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
  perform public.attendance_lock_tenant(p_tenant_id, true);

  v_today := public.attendance_today(p_tenant_id);

  if not exists (
    select 1 from public.attendance_offices
    where id = p_office_id
      and tenant_id = p_tenant_id
  ) then
    raise exception 'office % not found in tenant %', p_office_id, p_tenant_id
      using errcode = 'PT404',
            hint = 'ATTENDANCE_OFFICE_NOT_FOUND';
  end if;

  -- Already archived → idempotent no-op success (a double-tap or a retry
  -- must not error, and must not re-stamp archived_at).
  if exists (
    select 1 from public.attendance_offices
    where id = p_office_id
      and archived_at is not null
  ) then
    return;
  end if;

  -- Tracked employees with current or future assignments to this office
  -- block the archive. Shape per the AD-8 provisional declarations —
  -- reconciled when the tables land in 15-7.
  if exists (
    select 1
    from public.attendance_office_assignments a
    join public.attendance_enrolments e on e.employee_id = a.employee_id
    join public.users u on u.id = a.employee_id
    where a.office_id = p_office_id
      and u.tenant_id = p_tenant_id
      and e.enabled_at is not null
      and e.valid @> v_today
      and upper(a.valid) > v_today
  ) then
    raise exception 'office % has tracked employees assigned', p_office_id
      using errcode = 'PT409',
            hint = 'ATTENDANCE_OFFICE_ARCHIVE_BLOCKED';
  end if;

  update public.attendance_offices
    set archived_at = now()
    where id = p_office_id;
end;
$$;

-- AD-24 preview: the blocking employees for a candidate archive, shared by
-- the GET …/archive/preview route and the archive write's 409 body. Read
-- function — no lock, SECURITY DEFINER, service_role only. Also lazily
-- compiled against the 15-7 tables.
create or replace function public.attendance_office_archive_blockers(
  p_tenant_id uuid,
  p_office_id uuid
)
returns table (employee_id uuid, employee_name text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_today date;
begin
  v_today := public.attendance_today(p_tenant_id);

  return query
    select a.employee_id,
           coalesce(u.name, u.phone) as employee_name
    from public.attendance_office_assignments a
    join public.attendance_enrolments e on e.employee_id = a.employee_id
    join public.users u on u.id = a.employee_id
    where a.office_id = p_office_id
      and u.tenant_id = p_tenant_id
      and e.enabled_at is not null
      and e.valid @> v_today
      and upper(a.valid) > v_today;
end;
$$;

revoke execute on function public.attendance_create_office(uuid, uuid, text, double precision, double precision, integer, time, time, integer, numeric, numeric)
  from public, anon, authenticated;
revoke execute on function public.attendance_update_office_rules(uuid, uuid, uuid, time, time, integer, numeric, numeric)
  from public, anon, authenticated;
revoke execute on function public.attendance_archive_office(uuid, uuid, uuid)
  from public, anon, authenticated;
revoke execute on function public.attendance_office_archive_blockers(uuid, uuid)
  from public, anon, authenticated;

grant execute on function public.attendance_create_office(uuid, uuid, text, double precision, double precision, integer, time, time, integer, numeric, numeric) to service_role;
grant execute on function public.attendance_update_office_rules(uuid, uuid, uuid, time, time, integer, numeric, numeric) to service_role;
grant execute on function public.attendance_archive_office(uuid, uuid, uuid) to service_role;
grant execute on function public.attendance_office_archive_blockers(uuid, uuid) to service_role;