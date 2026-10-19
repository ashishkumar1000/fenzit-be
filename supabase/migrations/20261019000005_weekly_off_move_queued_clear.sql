-- Review patch for R-20/R-21 (code review 2026-10-19): a queued "no day off"
-- (clear) was not moved by a later save of "no day off", while the employee-wise
-- rule did move its empty-days marker.
--
-- A queued clear leaves no row: the rule in force is clipped at U
-- (valid = [from, U)) and nothing starts at U. Saving "no day off" from a later
-- date X must move that clear to X, so the days U..X-1 keep the earlier rule
-- instead of staying cleared.
--
-- Plain-English contract of attendance_set_weekly_off_default (NEW marked):
--   Same as 20261019000003, plus NEW: when the days being saved are EMPTY and
--   the date X falls in a still-future gap that starts where a rule was clipped
--   (nothing covers any day from that rule's end up to X), stretch that rule to
--   X. The usual replace-from-X step then runs unchanged.
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
