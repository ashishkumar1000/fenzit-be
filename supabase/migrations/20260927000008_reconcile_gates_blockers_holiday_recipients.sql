-- Story 15-7 (Epic 15): reconcile the pre-existing function bodies that were
-- shipped against the AD-8 provisional declarations and parked until the
-- enrolment/assignment tables existed (this story's
-- attendance_enrolment_tables migration). Per the user's 2026-09-28 "no new
-- RPCs" decision, NO new functions — every body here re-creates an existing
-- function. The holiday pair keeps its LIVE no-actor signatures (the dead
-- p_actor_id signatures were dropped by 20260927000005 — review finding:
-- re-creating them minted phantom overloads nobody calls while the live
-- entries kept the stale bodies; corrective apply
-- fix_15_7_review_criticals). The lifecycle itself runs transactionally in
-- the NestJS service over the direct pg connection (spec-15-7 Change Log).
--
-- The single tracked predicate, now real everywhere (mirrors the
-- attendance_access_state view; enrolment covers the date AND a live
-- (non-archived) office assignment covers it):
--   1. complete-setup Gate 2 — gains the archived-office filter (deferred
--      at 15-2 review: "reconciled in Story 15-7, where these predicates
--      belong").
--   2. archive blockers — one shared predicate for attendance_archive_office
--      and attendance_office_archive_blockers (the 15-3 review found the
--      copy-pasted predicate, unordered/duplicating list), blocking on ANY
--      current-or-future assignment of an enrolled employee — upper() of an
--      unbounded range is NULL on PG17, so the comparison coalesces to
--      'infinity' (a bare `upper(a.valid) > today` never matched the
--      active/upcoming assignments it was written for); display names use
--      the 20260927000003 country_code||phone_number expression.
--   3. holiday notification recipients + the AD-24 impact preview — the
--      dormant fan-out's predicate aligns with the tracked definition
--      (15-5 spec: "15-7 owns its final tracked predicate") and is gated on
--      setup COMPLETED **and enabled** — the kill switch is the module's
--      off act: no notifications fan out while it is off.

-- ------------------------------------------------------------------
-- Gate 2: tracked employee whose LIVE office assignment covers today.
-- ------------------------------------------------------------------
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
  if not exists (
    select 1 from public.attendance_offices o
    where o.tenant_id = p_tenant_id
      and o.archived_at is null
  ) then
    raise exception 'tenant % has no active office', p_tenant_id
      using errcode = 'PT422',
            hint = 'ATTENDANCE_SETUP_INCOMPLETE';
  end if;

  -- Gate 2: at least one tracked employee whose live office assignment
  -- covers today (the 15-7 reconciliation: enrolment covers the date AND
  -- the covering assignment's office is not archived).
  if not exists (
    select 1
    from public.attendance_enrolments e
    join public.attendance_office_assignments a on a.employee_id = e.employee_id
    join public.attendance_offices o on o.id = a.office_id
    join public.users u on u.id = e.employee_id
    where u.tenant_id = p_tenant_id
      and e.valid @> v_today
      and a.valid @> v_today
      and o.archived_at is null
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

-- ------------------------------------------------------------------
-- Archive blockers — the ONE predicate, shared by the write and the
-- preview. An employee blocks the archive while ANY of their assignments
-- to this office is current or future (upper(a.valid) > today) and they
-- are enrolled on that assignment's start (the enrolment/assignment
-- pairing the lifecycle co-writes). Past-only assignments — disabled
-- employees, history — never block (FR-5; FR-28's removed-employee
-- carve-out arrives with the removal feature).
-- ------------------------------------------------------------------
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
    select distinct a.employee_id,
           coalesce(
             nullif(u.name, ''),
             u.country_code || u.phone_number,
             'Unknown employee'
           ) as employee_name
    from public.attendance_office_assignments a
    join public.users u on u.id = a.employee_id
    where a.office_id = p_office_id
      and u.tenant_id = p_tenant_id
      and coalesce(upper(a.valid), 'infinity'::date) > v_today
      and exists (
        select 1
        from public.attendance_enrolments e
        where e.employee_id = a.employee_id
          and e.valid @> lower(a.valid)
      )
    order by 2;
end;
$$;

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
begin
  perform public.attendance_lock_tenant(p_tenant_id, true);

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

  -- The shared blocker predicate (above) — single source, no copy-paste.
  if exists (
    select 1
    from public.attendance_office_archive_blockers(p_tenant_id, p_office_id)
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

-- ------------------------------------------------------------------
-- Holiday lifecycle: the dormant recipient fan-out now runs against real
-- tables. The tracked predicate gains the live covering assignment — the
-- recipients for a future date are exactly the employees the
-- attendance_access_state view would call active or upcoming on that date.
-- (Bodies otherwise identical to 20260927000002.)
-- ------------------------------------------------------------------
create or replace function public.attendance_add_holiday(
  p_tenant_id uuid,
  p_holiday_date date,
  p_name text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_today     date;
  v_holiday_id uuid;
begin
  perform public.attendance_lock_tenant(p_tenant_id, true);

  v_today := public.attendance_today(p_tenant_id);

  -- Nested block: the unique_violation handler must scope to THIS insert
  -- only — a dedupe-key collision in the notification fan-out below must
  -- never be re-labelled as a taken holiday date.
  begin
    insert into public.holidays (tenant_id, holiday_date, name)
      values (p_tenant_id, p_holiday_date, p_name)
      returning id into v_holiday_id;
  exception
    when unique_violation then
      raise exception 'a holiday on % already exists in tenant %', p_holiday_date, p_tenant_id
        using errcode = 'PT409',
              hint = 'ATTENDANCE_HOLIDAY_TAKEN';
  end;

  -- Future dates broadcast to tracked employees (AD-13); past dates are
  -- silent (day statuses recompute on read, AD-10). Same transaction as
  -- the insert. Dedupe keys are recipient-prefixed, so a retried RPC
  -- inserts nothing the partial unique index doesn't already reject.
  if p_holiday_date > v_today then
    if exists (
      select 1 from public.attendance_settings
      where tenant_id = p_tenant_id
        and setup_completed_at is not null
        and enabled
    ) then
      insert into public.notifications
        (tenant_id, user_id, job_id, event_type, payload,
         entity_type, entity_id, dedupe_key)
      select p_tenant_id,
             e.employee_id,
             null,
             'attendance.holiday_added',
             jsonb_build_object(
               'holidayName', p_name,
               'holidayDate', to_char(p_holiday_date, 'YYYY-MM-DD')
             ),
             'attendance',
             v_holiday_id,
             p_tenant_id::text || ':attendance.holiday_added:'
               || e.employee_id::text || ':' || v_holiday_id::text
      from public.attendance_enrolments e
      join public.users u on u.id = e.employee_id
      join public.attendance_office_assignments a
        on a.employee_id = e.employee_id
       and a.valid @> p_holiday_date
      join public.attendance_offices o
        on o.id = a.office_id and o.archived_at is null
      where u.tenant_id = p_tenant_id
        and e.valid @> p_holiday_date;
    end if;
  end if;

  return v_holiday_id;
end;
$$;

create or replace function public.attendance_remove_holiday(
  p_tenant_id uuid,
  p_holiday_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_today        date;
  v_holiday_date date;
  v_holiday_name text;
begin
  perform public.attendance_lock_tenant(p_tenant_id, true);

  v_today := public.attendance_today(p_tenant_id);

  -- Capture name + date before the delete: the notification payload below
  -- is self-contained (it must survive the row it describes).
  select holiday_date, name into v_holiday_date, v_holiday_name
  from public.holidays
  where id = p_holiday_id
    and tenant_id = p_tenant_id;

  if v_holiday_date is null then
    raise exception 'holiday % not found in tenant %', p_holiday_id, p_tenant_id
      using errcode = 'PT404',
            hint = 'ATTENDANCE_HOLIDAY_NOT_FOUND';
  end if;

  -- Hard delete (FR-20); day statuses recompute on read (AD-10). Removed
  -- future holidays notify tracked employees so a planned day off doesn't
  -- vanish silently — symmetric with holiday_added.
  delete from public.holidays
    where id = p_holiday_id
      and tenant_id = p_tenant_id;

  if v_holiday_date > v_today then
    if exists (
      select 1 from public.attendance_settings
      where tenant_id = p_tenant_id
        and setup_completed_at is not null
        and enabled
    ) then
      insert into public.notifications
        (tenant_id, user_id, job_id, event_type, payload,
         entity_type, entity_id, dedupe_key)
      select p_tenant_id,
             e.employee_id,
             null,
             'attendance.holiday_removed',
             jsonb_build_object(
               'holidayName', v_holiday_name,
               'holidayDate', to_char(v_holiday_date, 'YYYY-MM-DD')
             ),
             'attendance',
             p_holiday_id,
             p_tenant_id::text || ':attendance.holiday_removed:'
               || e.employee_id::text || ':' || p_holiday_id::text
      from public.attendance_enrolments e
      join public.users u on u.id = e.employee_id
      join public.attendance_office_assignments a
        on a.employee_id = e.employee_id
       and a.valid @> v_holiday_date
      join public.attendance_offices o
        on o.id = a.office_id and o.archived_at is null
      where u.tenant_id = p_tenant_id
        and e.valid @> v_holiday_date;
    end if;
  end if;
end;
$$;

-- AD-24 preview: employees tracked on the holiday's date — the same
-- tracked predicate as the fan-out. EPIC 17 EXTENSION POINT: employees on
-- approved leave overlapping this date are added here (leave_requests /
-- leave_transition_days) — deferred by the 2026-09-27 scope decision.
create or replace function public.attendance_holiday_impact(
  p_tenant_id uuid,
  p_date date
)
returns table (employee_id uuid, employee_name text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  -- Fail loud on an unknown tenant, mirroring the other attendance reads.
  perform public.attendance_today(p_tenant_id);

  return query
    select e.employee_id,
           coalesce(
             nullif(u.name, ''),
             u.country_code || u.phone_number,
             'Unknown employee'
           ) as employee_name
    from public.attendance_enrolments e
    join public.users u on u.id = e.employee_id
    join public.attendance_office_assignments a
      on a.employee_id = e.employee_id
     and a.valid @> p_date
    join public.attendance_offices o
      on o.id = a.office_id and o.archived_at is null
    where u.tenant_id = p_tenant_id
      and e.valid @> p_date;
end;
$$;

-- Signatures unchanged — grants re-asserted in-file (AD-3).
revoke execute on function public.attendance_complete_setup(uuid, uuid)
  from public, anon, authenticated;
revoke execute on function public.attendance_office_archive_blockers(uuid, uuid)
  from public, anon, authenticated;
revoke execute on function public.attendance_archive_office(uuid, uuid, uuid)
  from public, anon, authenticated;
revoke execute on function public.attendance_add_holiday(uuid, date, text)
  from public, anon, authenticated;
revoke execute on function public.attendance_remove_holiday(uuid, uuid)
  from public, anon, authenticated;
revoke execute on function public.attendance_holiday_impact(uuid, date)
  from public, anon, authenticated;

grant execute on function public.attendance_complete_setup(uuid, uuid) to service_role;
grant execute on function public.attendance_office_archive_blockers(uuid, uuid) to service_role;
grant execute on function public.attendance_archive_office(uuid, uuid, uuid) to service_role;
grant execute on function public.attendance_add_holiday(uuid, date, text) to service_role;
grant execute on function public.attendance_remove_holiday(uuid, uuid) to service_role;
grant execute on function public.attendance_holiday_impact(uuid, date) to service_role;
