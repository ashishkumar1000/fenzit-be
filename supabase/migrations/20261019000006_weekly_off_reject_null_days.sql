-- Test-writing review (2026-10-19): the save RPCs treated p_days = NULL as an
-- empty array, i.e. silently as "no day off" (clipping future rules and stamping
-- weekly_off_configured_at). Only the API validator stopped it; a direct RPC call
-- did not. "No day off" is an EMPTY array; NULL is now rejected (23514, the same
-- check-violation backstop the app already maps).
--
-- Plain-English contract: unchanged from 20261019000005 (default) and
-- 20261019000004 (override), plus NEW: NULL p_days raises 23514 and writes nothing.
-- Only these two functions are replaced; signatures and access unchanged.

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
  v_queued_from    date;
begin
  -- NEW (test-writing review): NULL days is a caller bug, not "no day off"
  -- (that is an EMPTY array). The API validator blocks it; this is the DB backstop.
  if p_days is null then
    raise exception 'days is required (use an empty array for no day off)'
      using errcode = '23514';
  end if;

  perform public.attendance_lock_tenant(p_tenant_id, true);

  v_today := public.attendance_today(p_tenant_id);
  v_effective_from := greatest(coalesce(p_effective_from, v_today), v_today);

  v_days := coalesce(
    (select array_agg(distinct d order by d) from unnest(p_days) as d),
    '{}'::integer[]
  );

  if cardinality(v_days) = 7 then
    raise exception 'all seven days cannot be weekly offs'
      using errcode = 'PT422',
            hint = 'ATTENDANCE_NO_WORKING_DAYS';
  end if;

  -- NEW (R-20): same days saved from a later date than a still-future queued
  -- rule = move that queued rule. (Empty days never match: a clear has no row.)
  if cardinality(v_days) > 0 then
    select lower(valid) into v_queued_from
      from public.attendance_weekly_off_defaults
      where tenant_id = p_tenant_id
        and lower(valid) > v_today
        and lower(valid) < v_effective_from
        and valid @> v_effective_from
        and days = v_days;

    if v_queued_from is not null then
      delete from public.attendance_weekly_off_defaults
        where tenant_id = p_tenant_id
          and lower(valid) = v_queued_from;

      -- The rule that ended where the queued one began now runs to the new date.
      update public.attendance_weekly_off_defaults
        set valid = daterange(lower(valid), v_effective_from, '[)')
        where tenant_id = p_tenant_id
          and upper(valid) = v_queued_from;
    end if;
  end if;

  -- NEW (review patch): "no day off" saved from a later date than a queued
  -- clear moves that clear. Find the rule clipped in the future whose end is
  -- followed by an empty gap reaching the new date, and stretch it to the date.
  if cardinality(v_days) = 0 then
    update public.attendance_weekly_off_defaults r
      set valid = daterange(lower(r.valid), v_effective_from, '[)')
      where r.tenant_id = p_tenant_id
        and upper(r.valid) is not null
        and upper(r.valid) > v_today
        and upper(r.valid) < v_effective_from
        and not exists (
          select 1 from public.attendance_weekly_off_defaults o
          where o.tenant_id = p_tenant_id
            and o.valid && daterange(upper(r.valid), v_effective_from, '[)')
        );
  end if;

  delete from public.attendance_weekly_off_defaults
    where tenant_id = p_tenant_id
      and lower(valid) >= v_effective_from;

  update public.attendance_weekly_off_defaults
    set valid = daterange(lower(valid), v_effective_from, '[)')
    where tenant_id = p_tenant_id
      and valid @> v_effective_from;

  -- Empty days = clear-from: no new row (absence = all 7 days working).
  if cardinality(v_days) > 0 then
    insert into public.attendance_weekly_off_defaults (tenant_id, valid, days)
      values (p_tenant_id, daterange(v_effective_from, null, '[)'), v_days);
  end if;

  update public.tenants
    set weekly_off_configured_at = now()
    where id = p_tenant_id
      and weekly_off_configured_at is null;
end;
$$;

revoke execute on function public.attendance_set_weekly_off_default(uuid, integer[], date)
  from public, anon, authenticated;
grant execute on function public.attendance_set_weekly_off_default(uuid, integer[], date)
  to service_role;

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
  v_queued_from    date;
begin
  -- NEW (test-writing review): NULL days is a caller bug, not "no day off"
  -- (that is an EMPTY array). The API validator blocks it; this is the DB backstop.
  if p_days is null then
    raise exception 'days is required (use an empty array for no day off)'
      using errcode = '23514';
  end if;

  perform public.attendance_lock_tenant(p_tenant_id, true);

  v_today := public.attendance_today(p_tenant_id);
  v_effective_from := greatest(coalesce(p_effective_from, v_today), v_today);

  -- The override target must be a member of this tenant.
  if not exists (
    select 1 from public.users
    where id = p_employee_id
      and tenant_id = p_tenant_id
  ) then
    raise exception 'employee % not found in tenant %', p_employee_id, p_tenant_id
      using errcode = 'PT404',
            hint = 'ATTENDANCE_EMPLOYEE_NOT_FOUND';
  end if;

  -- The member must be active (R-04). Invited people cannot have a pattern.
  if not exists (
    select 1 from public.users
    where id = p_employee_id
      and tenant_id = p_tenant_id
      and status = 'active'
  ) then
    raise exception 'employee % is not active in tenant %', p_employee_id, p_tenant_id
      using errcode = 'PT422',
            hint = 'ATTENDANCE_EMPLOYEE_NOT_ACTIVE';
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

  -- NEW: same days saved from a later date than this employee's still-future
  -- queued rule = move that queued rule. '{}' is a real row, so it can match.
  select lower(valid) into v_queued_from
    from public.attendance_weekly_off_overrides
    where employee_id = p_employee_id
      and lower(valid) > v_today
      and lower(valid) < v_effective_from
      and valid @> v_effective_from
      and days = v_days;

  if v_queued_from is not null then
    delete from public.attendance_weekly_off_overrides
      where employee_id = p_employee_id
        and lower(valid) = v_queued_from;

    -- The rule that ended where the queued one began now runs to the new date.
    update public.attendance_weekly_off_overrides
      set valid = daterange(lower(valid), v_effective_from, '[)')
      where employee_id = p_employee_id
        and upper(valid) = v_queued_from;
  end if;

  delete from public.attendance_weekly_off_overrides
    where employee_id = p_employee_id
      and lower(valid) >= v_effective_from;

  update public.attendance_weekly_off_overrides
    set valid = daterange(lower(valid), v_effective_from, '[)')
    where employee_id = p_employee_id
      and valid @> v_effective_from;

  -- Always insert, empty days included: '{}' is the works-all-7-days marker
  -- (AD-22 replace). Clearing an override is the separate removal RPC.
  insert into public.attendance_weekly_off_overrides
    (tenant_id, employee_id, valid, days)
    values (p_tenant_id, p_employee_id, daterange(v_effective_from, null, '[)'), v_days);
end;
$$;

revoke execute on function public.attendance_set_weekly_off_override(uuid, uuid, integer[], date)
  from public, anon, authenticated;
grant execute on function public.attendance_set_weekly_off_override(uuid, uuid, integer[], date)
  to service_role;

