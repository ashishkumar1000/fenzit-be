-- Defect R-11 (weekly-off screen test run, 2026-10-18): an owner who saved
-- "no day off" (everyone works all 7 days) saw the never-configured screen
-- again after reopening the app, with Sunday shown off.
--
-- Cause: saving "no day off" deletes the default row (absence of a row = all 7
-- days working), so GET cannot tell "cleared on purpose" from "never set up".
--
-- Fix (database owns the fact): tenants.weekly_off_configured_at is stamped the
-- first time the owner saves the everyone rule — empty days included. The API
-- returns it as `configured`. Once set it is never cleared.
--
-- Plain-English contract of attendance_set_weekly_off_default (NEW marked):
--   Same as 20260927000005, plus NEW: after a successful save, if the tenant
--   has no weekly_off_configured_at yet, set it to now().
--
-- No backfill: pre-launch, there is no existing tenant data to protect.

alter table public.tenants
  add column if not exists weekly_off_configured_at timestamptz;

comment on column public.tenants.weekly_off_configured_at is
  'Set once, the first time the owner saves the everyone weekly-off rule (empty days included). Internal marker; the API exposes it as the boolean `configured`.';

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

  -- NEW (R-11): remember that the owner has made a choice, even "no day off".
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
