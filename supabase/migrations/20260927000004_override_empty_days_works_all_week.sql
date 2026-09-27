-- Story 15-5 corrective migration (2026-09-27): an empty-days OVERRIDE stores
-- the "works all 7 days" marker row.
--
-- 20260927000002 shipped attendance_set_weekly_off_override with the same
-- empty-days behaviour as the default setter (clip+delete, insert nothing) —
-- caught by the 15-5 real-DB probe: SET override days = {} returned success
-- but left zero rows, silently falling the employee back to the tenant
-- default. That contradicts the signed-off scope decision (the authority
-- here): an empty days array on an override is the ONLY way to express
-- "this employee works all 7 days while the tenant has a weekly off", because
-- an override REPLACES the default while its range covers the date (AD-22) —
-- absence of an override row means the default applies, so there is nothing
-- to fall back to; the marker row IS the statement. Removal stays a separate,
-- distinct operation (attendance_remove_weekly_off_override; the row goes,
-- the default resumes). The spec's Boundaries sentence ("... or empty-days
-- set ... clips/deletes and inserts nothing") is over-broad: it governs the
-- DEFAULT table only, where absence of a covering row already means all 7
-- days working and no marker is needed. The asymmetry is deliberate:
--   DEFAULT  days = {} → clear-from (no row — absence = all working);
--   OVERRIDE days = {} → marker row (presence = all working despite default).
--
-- Fix: the override setter inserts unconditionally. Everything else — the
-- tenant lock, the today clamp, the membership guard, the deduped/sorted
-- days, the PT422 seven-day reject, the delete+clip+insert sequence and the
-- GIST exclusion interplay — is byte-identical to 20260927000002. The
-- attendance_weekly_off_overrides CHECKs already permit the empty marker
-- (days <@ ARRAY[1..7], cardinality(days) < 7). The default setter and the
-- remove RPC are NOT touched.

create or replace function public.attendance_set_weekly_off_override(
  p_tenant_id uuid,
  p_actor_id uuid,
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
  -- an empty set — that is the default table's idiom, not this one's.
  insert into public.attendance_weekly_off_overrides
    (tenant_id, employee_id, valid, days)
    values (p_tenant_id, p_employee_id, daterange(v_effective_from, null, '[)'), v_days);
end;
$$;

-- AD-3 triple restated per the in-file rule (create or replace keeps grants;
-- the file stays self-contained) — the 20260926000008 precedent.
revoke execute on function public.attendance_set_weekly_off_override(uuid, uuid, uuid, integer[], date)
  from public, anon, authenticated;

grant execute on function public.attendance_set_weekly_off_override(uuid, uuid, uuid, integer[], date)
  to service_role;
