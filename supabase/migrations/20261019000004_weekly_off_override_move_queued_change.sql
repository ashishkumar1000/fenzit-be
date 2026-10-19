-- Follow-up to R-20 (see 20261019000003) for the EMPLOYEE-WISE weekly-off rule.
-- Changing only the starting date of a queued employee-wise change (days
-- unchanged) used to clip the queued rule and start a duplicate one.
--
-- Decision (owner, 2026-10-19): saving the SAME days from a LATER date than a
-- queued change MOVES that change, for employee-wise rules too.
--
-- Plain-English contract of attendance_set_weekly_off_override (NEW marked):
--   Same as 20261018000002 (tenant lock, employee must be in this tenant
--   -> PT404, must be active -> PT422, all seven days off -> PT422), plus NEW:
--   before the usual replace-from-date step, if the date being saved falls
--   inside a still-future rule OF THE SAME EMPLOYEE that has exactly the days
--   being saved, that rule is a queued change being moved. Remove it and
--   stretch the same employee's earlier rule (if it ended where the queued
--   one began) up to the new date, so the days before the new date revert to
--   the earlier rule instead of leaving a hole or a duplicate.
--   Unlike the everyone rule, empty days ('{}') IS a stored row here (the
--   works-all-7-days marker), so the move applies to any days value, '{}'
--   included, as long as it is exactly equal.
--   Saving the same days from an EARLIER date already worked and is unchanged.
--
-- Only this one function is replaced; signature unchanged. Access restated
-- (service_role only).

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
