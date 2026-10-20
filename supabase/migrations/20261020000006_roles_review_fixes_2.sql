-- Review round 2 fixes. Both patch an existing function in place and raise if
-- the expected text is missing, so a changed function is never silently skipped.

do $outer$
declare
  v_def text;
  v_new text;
begin
  -- 1. invite_member: refuse a dial code that is not in country_codes with
  --    VALIDATION_ERROR (it used to surface as a raw 23503 foreign-key error).
  v_def := pg_get_functiondef('public.invite_member(uuid, uuid, text, text, text, text, uuid[])'::regprocedure);
  v_new := replace(v_def,
$a$  if exists (
    select 1 from unnest(coalesce(p_skill_ids$a$,
$b$  if not exists (select 1 from public.country_codes c where c.dial_code = p_country_code) then
    raise exception 'country code % is not supported', p_country_code
      using errcode = 'PT400', hint = 'VALIDATION_ERROR';
  end if;
  if exists (
    select 1 from unnest(coalesce(p_skill_ids$b$);
  if v_new = v_def then
    raise exception 'invite_member: expected text not found, nothing patched';
  end if;
  execute v_new;

  -- 2. attendance_run_reminders: only ACTIVE, not-disabled members count as
  --    employees. A removed or disabled person no longer gets reminders and no
  --    longer counts in the office summary.
  v_def := pg_get_functiondef('public.attendance_run_reminders(timestamp with time zone)'::regprocedure);
  v_new := replace(v_def,
$a$            where e.tenant_id = v_tenant_id
              and e.valid @> v_today
          ) inner_facts$a$,
$b$            where e.tenant_id = v_tenant_id
              and e.valid @> v_today
              and exists (
                select 1 from public.memberships em
                join public.users eu on eu.id = em.user_id
                where em.user_id = e.employee_id
                  and em.tenant_id = v_tenant_id
                  and em.status = 'active'
                  and not eu.disabled
              )
          ) inner_facts$b$);
  if v_new = v_def then
    raise exception 'attendance_run_reminders: expected text not found, nothing patched';
  end if;
  execute v_new;
end $outer$;
