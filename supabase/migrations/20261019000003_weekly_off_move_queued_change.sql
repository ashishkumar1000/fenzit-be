-- Defect R-20 (weekly-off screen test run, 2026-10-18): changing only the
-- starting date of a queued change (days unchanged) did not move the queued
-- rule. The save clipped it at the new date and started a duplicate rule, e.g.
-- [18,25){6} [25,28){7} [28,){7} instead of [18,28){6} [28,){7}.
--
-- Decision (owner, 2026-10-19): saving the SAME days from a LATER date than a
-- queued change MOVES that change.
--
-- Plain-English contract of attendance_set_weekly_off_default (NEW marked):
--   Same as 20261019000001, plus NEW: before the usual replace-from-date step,
--   if the date being saved falls inside a still-future rule that has exactly
--   the days being saved, that rule is a queued change being moved. Remove it
--   and stretch the rule before it (if it ended where the queued one began)
--   up to the new date, so the days before the new date revert to the earlier
--   rule instead of leaving a hole or a duplicate.
--   Saving the same days from an EARLIER date already worked (the later rule is
--   deleted by the usual step) and is unchanged.
--
-- Only this one function is replaced; signature unchanged. Access restated
-- (service_role only).

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
