-- Story 15-5 amendment (2026-09-27): fix the employee display-name fallback.
--
-- attendance_holiday_impact (this story) and attendance_office_archive_blockers
-- (15-3) read the employee's name with coalesce(u.name, u.phone) — but
-- users.phone was split into country_code + phone_number back in
-- 20260620000002. PL/pgSQL plans lazily, so both functions applied cleanly
-- and the defect stayed dormant: holiday_impact would fail at first call
-- (42703, undefined column) — pre-15-7, where it must return an empty list —
-- and the blockers read would have failed the same way the moment 15-7
-- made it callable.
--
-- Same fix in both: name first, then the reassembled E.164 number, then a
-- plain placeholder. The dial code already carries its '+' —
-- users.country_code is FK-enforced to country_codes.dial_code, which stores
-- '+91' — so the reassembly is country_code || phone_number with NO extra
-- prefix (an earlier draft of this file concatenated a second '+' and would
-- have rendered '++91…'; caught by the 15-5 unit spec before commit). The
-- AD-3 triple is restated per the in-file rule (create or replace keeps
-- grants; the file stays self-contained) — the 20260926000008 precedent.

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

create or replace function public.attendance_office_archive_blockers(
  p_tenant_id uuid,
  p_office_id uuid
)
returns table (employee_id uuid, employee_name text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_today date;
begin
  v_today := public.attendance_today(p_tenant_id);

  return query
    select a.employee_id,
           coalesce(
             nullif(u.name, ''),
             u.country_code || u.phone_number,
             'Unknown employee'
           ) as employee_name
    from public.attendance_office_assignments a
    join public.attendance_enrolments e on e.employee_id = a.employee_id
    join public.users u on u.id = a.employee_id
    where a.office_id = p_office_id
      and u.tenant_id = p_tenant_id
      and e.enabled_at is not null
      and e.valid @> v_today
      and upper(a.valid) > v_today;
end;
$$;

revoke execute on function public.attendance_holiday_impact(uuid, date)
  from public, anon, authenticated;
revoke execute on function public.attendance_office_archive_blockers(uuid, uuid)
  from public, anon, authenticated;

grant execute on function public.attendance_holiday_impact(uuid, date)
  to service_role;
grant execute on function public.attendance_office_archive_blockers(uuid, uuid)
  to service_role;