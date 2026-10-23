-- Holiday impact preview: report APPROVED-LEAVE overlap, not tracked
-- employees. Owner-reported 2026-10-23: the add-holiday sheet warned
-- "This date overlaps N's approved leave" for EVERY date — the function
-- was still Epic 17's extension-point stub, which lists every enrolled
-- employee whose enrolment + office assignment cover the date, and the FE
-- banner labels that list as approved-leave overlap (the copy the FE has
-- shipped since 15-6). Epic 17's leave days are live, so the preview now
-- answers the contract the copy always stated: employees whose
-- leave_request_day falls on the holiday date with state 'approved'.
-- Pending days are not leave yet; cancelled days are not leave at all —
-- neither matches.

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

  return query
    select d.employee_id,
           coalesce(
             nullif(u.name, ''),
             u.country_code || u.phone_number,
             'Unknown employee'
           ) as employee_name
    from public.leave_request_days d
    join public.users u on u.id = d.employee_id
    join public.memberships m
      on m.user_id = d.employee_id
     and m.tenant_id = p_tenant_id
     and m.status <> 'removed'
    where d.tenant_id = p_tenant_id
      and d.leave_date = p_date
      and d.state = 'approved';
end;
$$;

-- AD-3 triple restated per the in-file rule (create or replace keeps
-- grants; the file stays self-contained).
revoke execute on function public.attendance_holiday_impact(uuid, date)
  from public, anon, authenticated;

grant execute on function public.attendance_holiday_impact(uuid, date)
  to service_role;
