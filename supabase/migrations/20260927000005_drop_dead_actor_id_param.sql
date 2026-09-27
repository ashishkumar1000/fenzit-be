-- Story 15-5 review fix (2026-09-27): drop the dead p_actor_id parameter.
--
-- All six lifecycle RPCs below declared p_actor_id and the NestJS services
-- passed it, but no function body ever referenced it — the attendance
-- tables carry no audit columns to receive it (user decision 2026-09-27:
-- drop the dead contract pre-launch rather than carry it into Epic 16).
--
-- A changed signature mints a NEW pg_proc entry, so each OLD-signature
-- function is dropped explicitly (the old entries would otherwise linger,
-- still granted to service_role by migrations 02/04). Bodies are byte-
-- identical to the live state: the default setter, remove RPC and the
-- holiday trio exactly as 20260927000002 shipped them; the override setter
-- as 20260927000004 amended it (unconditional insert — the empty-days
-- marker). The AD-3 triple is restated for each new entry per the in-file
-- rule (the 20260926000008 precedent). attendance_holiday_impact has no
-- actor parameter and is not touched here.

drop function if exists public.attendance_set_weekly_off_default(uuid, uuid, integer[], date);
drop function if exists public.attendance_set_weekly_off_override(uuid, uuid, uuid, integer[], date);
drop function if exists public.attendance_remove_weekly_off_override(uuid, uuid, uuid, date);
drop function if exists public.attendance_add_holiday(uuid, uuid, date, text);
drop function if exists public.attendance_update_holiday(uuid, uuid, uuid, text);
drop function if exists public.attendance_remove_holiday(uuid, uuid, uuid);

create or replace function public.attendance_set_weekly_off_default(
  p_tenant_id uuid,
  p_days integer[],
  p_effective_from date
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_today          date;
  v_effective_from date;
  v_days           integer[];
begin
  perform public.attendance_lock_tenant(p_tenant_id, true);

  v_today := public.attendance_today(p_tenant_id);
  -- Past dates are clamped to today ("dates before it are unchanged", AD-8);
  -- a NULL effective_from means today (the RPC default).
  v_effective_from := greatest(coalesce(p_effective_from, v_today), v_today);

  -- Sort + dedupe: the stored array is canonical regardless of client order.
  v_days := coalesce(
    (select array_agg(distinct d order by d) from unnest(p_days) as d),
    '{}'::integer[]
  );

  -- FR-18: at least one working day must remain. The days CHECKs back this
  -- up on insert; this raise gives the specific error code pre-DB.
  if cardinality(v_days) = 7 then
    raise exception 'all seven days cannot be weekly offs'
      using errcode = 'PT422',
            hint = 'ATTENDANCE_NO_WORKING_DAYS';
  end if;

  -- Step 2: drop future ranges (a same-day re-edit replaces, no zombies).
  delete from public.attendance_weekly_off_defaults
    where tenant_id = p_tenant_id
      and lower(valid) >= v_effective_from;

  -- Step 3: clip the covering range at effective_from. Rows starting
  -- exactly on effective_from were already deleted above, so the clipped
  -- range can never be empty (the NOT isempty CHECK holds).
  update public.attendance_weekly_off_defaults
    set valid = daterange(lower(valid), v_effective_from, '[)')
    where tenant_id = p_tenant_id
      and valid @> v_effective_from;

  -- Step 4: the new open range. Skipped for an empty days set — that is a
  -- clear-from (absence of a covering row = all 7 days working).
  if cardinality(v_days) > 0 then
    insert into public.attendance_weekly_off_defaults (tenant_id, valid, days)
      values (p_tenant_id, daterange(v_effective_from, null, '[)'), v_days);
  end if;
end;
$$;

create or replace function public.attendance_set_weekly_off_override(
  p_tenant_id uuid,
  p_employee_id uuid,
  p_days integer[],
  p_effective_from date
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_today          date;
  v_effective_from date;
  v_days           integer[];
begin
  perform public.attendance_lock_tenant(p_tenant_id, true);

  v_today := public.attendance_today(p_tenant_id);
  v_effective_from := greatest(coalesce(p_effective_from, v_today), v_today);

  -- The override target must be a member of this tenant. No tracked gate
  -- pre-15-7: enrolments don't exist; the override is inert until the
  -- employee is enrolled (15-7 owns that predicate).
  if not exists (
    select 1 from public.users
    where id = p_employee_id
      and tenant_id = p_tenant_id
  ) then
    raise exception 'employee % not found in tenant %', p_employee_id, p_tenant_id
      using errcode = 'PT404',
            hint = 'ATTENDANCE_EMPLOYEE_NOT_FOUND';
  end if;

  v_days := coalesce(
    (select array_agg(distinct d order by d) from unnest(p_days) as d),
    '{}'::integer[]
  );

  if cardinality(v_days) = 7 then
    raise exception 'all seven days cannot be weekly offs'
      using errcode = 'PT422',
            hint = 'ATTENDANCE_NO_WORKING_DAYS';
  end if;

  delete from public.attendance_weekly_off_overrides
    where employee_id = p_employee_id
      and lower(valid) >= v_effective_from;

  update public.attendance_weekly_off_overrides
    set valid = daterange(lower(valid), v_effective_from, '[)')
    where employee_id = p_employee_id
      and valid @> v_effective_from;

  -- Always insert, empty days included: '{}' is the works-all-7-days marker
  -- (AD-22 replace). Clearing an override is the separate removal RPC, never
  -- an empty set — that is the default table's idiom, not this one's
  -- (20260927000004).
  insert into public.attendance_weekly_off_overrides
    (tenant_id, employee_id, valid, days)
    values (p_tenant_id, p_employee_id, daterange(v_effective_from, null, '[)'), v_days);
end;
$$;

create or replace function public.attendance_remove_weekly_off_override(
  p_tenant_id uuid,
  p_employee_id uuid,
  p_effective_from date
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_today          date;
  v_effective_from date;
begin
  perform public.attendance_lock_tenant(p_tenant_id, true);

  v_today := public.attendance_today(p_tenant_id);
  v_effective_from := greatest(coalesce(p_effective_from, v_today), v_today);

  if not exists (
    select 1 from public.users
    where id = p_employee_id
      and tenant_id = p_tenant_id
  ) then
    raise exception 'employee % not found in tenant %', p_employee_id, p_tenant_id
      using errcode = 'PT404',
            hint = 'ATTENDANCE_EMPLOYEE_NOT_FOUND';
  end if;

  -- Clip-without-insert: earlier override dates keep their override; from
  -- effective_from the employee reads the tenant default (FR-19). No
  -- covering range → idempotent no-op.
  delete from public.attendance_weekly_off_overrides
    where employee_id = p_employee_id
      and lower(valid) >= v_effective_from;

  update public.attendance_weekly_off_overrides
    set valid = daterange(lower(valid), v_effective_from, '[)')
    where employee_id = p_employee_id
      and valid @> v_effective_from;
end;
$$;

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
  -- silent (day statuses recompute on read, AD-10). Same transaction as the
  -- insert. The recipients query is unreachable until 15-7 creates the
  -- enrolments table (Amendment-2 guard — see the 20260927000002 header);
  -- the setup-completed gate keeps the fan-out off for tenants still in the
  -- wizard. Dedupe keys are recipient-prefixed, so a retried RPC inserts
  -- nothing the partial unique index doesn't already reject.
  if p_holiday_date > v_today then
    if to_regclass('public.attendance_enrolments') is not null then
      if exists (
        select 1 from public.attendance_settings
        where tenant_id = p_tenant_id
          and setup_completed_at is not null
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
        where u.tenant_id = p_tenant_id
          and e.enabled_at is not null
          and e.valid @> p_holiday_date;
      end if;
    end if;
  end if;

  return v_holiday_id;
end;
$$;

create or replace function public.attendance_update_holiday(
  p_tenant_id uuid,
  p_holiday_id uuid,
  p_name text
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  perform public.attendance_lock_tenant(p_tenant_id, true);

  perform public.attendance_today(p_tenant_id);

  -- Name only — the date is immutable (impact and notifications differ per
  -- date; a date change is remove + add). Guarded UPDATE: the tenant filter
  -- makes cross-tenant indistinguishable from not-found.
  update public.holidays
    set name = p_name
    where id = p_holiday_id
      and tenant_id = p_tenant_id;

  if not found then
    raise exception 'holiday % not found in tenant %', p_holiday_id, p_tenant_id
      using errcode = 'PT404',
            hint = 'ATTENDANCE_HOLIDAY_NOT_FOUND';
  end if;
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
  -- vanish silently — symmetric with holiday_added (scope decision
  -- 2026-09-27). Same Amendment-2 guard as add.
  delete from public.holidays
    where id = p_holiday_id
      and tenant_id = p_tenant_id;

  if v_holiday_date > v_today then
    if to_regclass('public.attendance_enrolments') is not null then
      if exists (
        select 1 from public.attendance_settings
        where tenant_id = p_tenant_id
          and setup_completed_at is not null
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
        where u.tenant_id = p_tenant_id
          and e.enabled_at is not null
          and e.valid @> v_holiday_date;
      end if;
    end if;
  end if;
end;
$$;

-- AD-3 triple for the NEW signatures (the old-signature entries were
-- dropped above; the 20260925000003 in-file rule — never depend on default
-- privilege history).
revoke execute on function public.attendance_set_weekly_off_default(uuid, integer[], date)
  from public, anon, authenticated;
revoke execute on function public.attendance_set_weekly_off_override(uuid, uuid, integer[], date)
  from public, anon, authenticated;
revoke execute on function public.attendance_remove_weekly_off_override(uuid, uuid, date)
  from public, anon, authenticated;
revoke execute on function public.attendance_add_holiday(uuid, date, text)
  from public, anon, authenticated;
revoke execute on function public.attendance_update_holiday(uuid, uuid, text)
  from public, anon, authenticated;
revoke execute on function public.attendance_remove_holiday(uuid, uuid)
  from public, anon, authenticated;

grant execute on function public.attendance_set_weekly_off_default(uuid, integer[], date)
  to service_role;
grant execute on function public.attendance_set_weekly_off_override(uuid, uuid, integer[], date)
  to service_role;
grant execute on function public.attendance_remove_weekly_off_override(uuid, uuid, date)
  to service_role;
grant execute on function public.attendance_add_holiday(uuid, date, text)
  to service_role;
grant execute on function public.attendance_update_holiday(uuid, uuid, text)
  to service_role;
grant execute on function public.attendance_remove_holiday(uuid, uuid)
  to service_role;
