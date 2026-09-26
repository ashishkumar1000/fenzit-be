-- Story 15-3 amendment (2026-09-26): archive works before Story 15-7.
--
-- The original attendance_archive_office shipped "fail loud" (42P01) until
-- the 15-7 enrolment/assignment tables landed — its blocker probe referenced
-- tables that do not exist yet. That made archive a live 500 for every
-- office, even a clean one, which blocks the 15-4 device walkthrough.
--
-- Guard the blocker probe by branching on to_regclass: while
-- attendance_office_assignments does not exist, the probe statement is never
-- reached (PL/pgSQL plans a statement only when first executed — lazily).
-- NOTE the probe must live in its own nested IF, not be AND-ed with the
-- existence flag: PL/pgSQL plans a whole IF expression as one query, so a
-- missing table in the subquery fails at plan time even when the flag is
-- false. When 15-7 creates the table the check self-activates with no
-- further change (15-7 still owns the full blocker predicate and the
-- preview function, which stays fail loud).
--
-- Everything else in the body is unchanged from 20260926000006; the AD-3
-- grant triple is restated in this file per the in-file rule (create or
-- replace keeps existing grants, but the file stays self-contained).

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
  v_today              date;
  v_assignments_exists boolean;
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
  -- reconciled when the tables land in 15-7. The probe runs only when the
  -- assignment table exists (to_regclass is null before 15-7): archiving
  -- with nothing assignable to the office is a clean archive.
  -- Nested IF, never a combined boolean: the flag keeps the (missing-table)
  -- probe statement unreached pre-15-7 — an AND-ed condition would still
  -- fail at plan time (see header).
  -- Both tables the probe joins must exist, not just the first: the probe
  -- references attendance_enrolments too, so a rollout window where only
  -- attendance_office_assignments exists (15-7 migration ordering) would
  -- otherwise re-42P01 the archive. to_regclass is a function call — safe to
  -- AND here; the lazy-planning hazard in the header applies only to the
  -- probe statement itself, which stays inside its own nested IF.
  v_assignments_exists :=
    to_regclass('public.attendance_office_assignments') is not null
    and to_regclass('public.attendance_enrolments') is not null;

  if v_assignments_exists then
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
  end if;

  update public.attendance_offices
    set archived_at = now()
    where id = p_office_id;
end;
$$;

revoke execute on function public.attendance_archive_office(uuid, uuid, uuid)
  from public, anon, authenticated;

grant execute on function public.attendance_archive_office(uuid, uuid, uuid) to service_role;
