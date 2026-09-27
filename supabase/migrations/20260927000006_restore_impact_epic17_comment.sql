-- Story 15-5 review fix (2026-09-27): restore the EPIC 17 extension-point
-- comment on attendance_holiday_impact.
--
-- 20260927000003's create or replace (the employee display-name fix) shipped
-- without the comment block that 20260927000002 carried above the function —
-- so the live definition lost the note marking this function as Epic 17's
-- extension point for leave impact. The comment survives in migration 02
-- (historical) and docs/api-contracts.md; this file restores it so whoever
-- extends the function in Epic 17 finds the contract in place. Body byte-
-- identical to 20260927000003 (the fixed display fallback); the AD-3 triple
-- is restated per the in-file rule.

-- AD-24 preview: employees tracked on the holiday's date. Pre-15-7 the
-- guard branch is unreached and the list is empty (never a 42P01 — the
-- 15-6 walkthrough calls this before 15-7 exists). Read function: no lock.
-- EPIC 17 EXTENSION POINT: employees on approved leave overlapping this
-- date are added here (leave_requests / leave_transition_days) — deferred
-- by the 2026-09-27 scope decision, together with the holiday-inside-leave
-- notification ACs (spec-15-5 scope decisions).
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

  if to_regclass('public.attendance_enrolments') is not null then
    return query
      select e.employee_id,
             coalesce(
               nullif(u.name, ''),
               u.country_code || u.phone_number,
               'Unknown employee'
             ) as employee_name
      from public.attendance_enrolments e
      join public.users u on u.id = e.employee_id
      where u.tenant_id = p_tenant_id
        and e.enabled_at is not null
        and e.valid @> p_date;
  end if;
end;
$$;

-- AD-3 triple restated per the in-file rule (create or replace keeps
-- grants; the file stays self-contained).
revoke execute on function public.attendance_holiday_impact(uuid, date)
  from public, anon, authenticated;

grant execute on function public.attendance_holiday_impact(uuid, date)
  to service_role;
