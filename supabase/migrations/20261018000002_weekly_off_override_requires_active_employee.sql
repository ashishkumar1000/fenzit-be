-- Defect R-04 (weekly-off screen test run, 2026-10-18): setting a weekly-off
-- override for an employee whose users.status is 'invited' wrongly succeeded.
-- An invited person has not joined yet, so they cannot have a roster pattern.
--
-- Plain-English contract of attendance_set_weekly_off_override (changed bit
-- marked NEW):
--   1. Lock the tenant, work out "today" in the tenant's time zone.
--   2. The employee must belong to this tenant, else error PT404
--      (ATTENDANCE_EMPLOYEE_NOT_FOUND) -> API answers 404.
--   3. NEW: the employee must have status = 'active', else error PT422
--      (ATTENDANCE_EMPLOYEE_NOT_ACTIVE) -> API answers 422.
--   4. Everything after that is unchanged from 20260927000005.
--
-- The REMOVE function is deliberately NOT changed: removing an override stays
-- open for any tenant member, so an owner can always clean up.
--
-- Only the SET function is replaced. Same signature as before, so
-- "create or replace" overwrites it in place; the revoke/grant triple is
-- restated below so access never depends on earlier history (service_role only).

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

  -- NEW (R-04): the member must be active. Invited (not yet joined) people
  -- cannot be given a weekly-off pattern.
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
