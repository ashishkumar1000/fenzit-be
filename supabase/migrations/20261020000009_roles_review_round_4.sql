-- Roles and access: fixes from the review of the whole backend change set.
--
-- Plain-English contract
--   * set_user_disabled: a platform admin cannot disable the last active company
--     admin of a company (LAST_ADMIN). The company is locked while the check runs,
--     so two disables at the same moment cannot both pass.
--   * invite_member: the existing-person lookup takes a row lock, so a person
--     cannot be disabled between the check and the new membership.
--   * private.user_in_my_company: counts only ACTIVE, not-disabled memberships.
--     Invited and removed people no longer pass the users and user_skills policies.
--   * Holiday fan-out, the setup gate and the holiday and office previews count
--     only ACTIVE, not-disabled members (one rule, not "not removed").
--   * The pending-leave reminder count counts only leave of ACTIVE, not-disabled
--     employees.
--   * "Who did it" columns (leave requests and events, attendance corrections and
--     day overrides): a row may only name a platform admin, or an ACTIVE member of
--     the row's own company. Checked on insert.
--   * jobs: only a company admin inserts, changes or deletes a job row. Employees
--     advance jobs through the SECURITY DEFINER workflow function, not the table.
--
-- The text patches below raise if the expected text is not found exactly as often
-- as expected, so a changed function is never silently skipped.

-- 1. Text patches to existing functions ---------------------------------------------
do $outer$
declare
  v_def text;
  v_new text;
  v_old text;
  v_rep text;
  v_count int;
  r record;
begin
  -- 1a. "Tracked employee" = active and not disabled (holiday fan-out, setup gate
  --     and the holiday and office previews).
  for r in
    select p.oid, p.proname
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('attendance_add_holiday', 'attendance_remove_holiday', 'attendance_complete_setup',
                         'attendance_holiday_impact', 'attendance_office_archive_blockers')
  loop
    v_def := pg_get_functiondef(r.oid);
    v_new := v_def;
    if r.proname in ('attendance_holiday_impact', 'attendance_office_archive_blockers') then
      v_old := 'm.status <> ''removed''';
      v_rep := 'm.status = ''active'' and not exists (select 1 from public.users dm where dm.id = m.user_id and dm.disabled)';
    else
      v_old := 'u.status <> ''removed''';
      v_rep := 'u.status = ''active'' and not exists (select 1 from public.users du where du.id = u.user_id and du.disabled)';
    end if;
    v_count := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
    if v_count < 1 then
      raise exception '% : expected text not found, nothing patched', r.proname;
    end if;
    v_new := replace(v_def, v_old, v_rep);
    execute v_new;
  end loop;

  -- 1b. Pending-leave reminder count: only leave of tracked employees.
  v_def := pg_get_functiondef('public.attendance_run_reminders(timestamp with time zone)'::regprocedure);
  v_old := 'and lrd.state = ''pending''';
  v_rep := 'and lrd.state = ''pending''
            and exists (
              select 1 from public.memberships pm
              join public.users pu on pu.id = pm.user_id
              where pm.user_id = lrd.employee_id
                and pm.tenant_id = v_tenant_id
                and pm.status = ''active''
                and not pu.disabled
            )';
  v_count := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  if v_count <> 1 then
    raise exception 'attendance_run_reminders: expected pending-leave text once, found %, nothing patched', v_count;
  end if;
  execute replace(v_def, v_old, v_rep);

  -- 1c. invite_member: lock the existing person's row while we decide.
  v_def := pg_get_functiondef('public.invite_member(uuid, uuid, text, text, text, text, uuid[])'::regprocedure);
  v_old := E'order by u.created_at\n     limit 1;';
  v_rep := E'order by u.created_at\n     limit 1\n     for update;';
  v_count := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  if v_count <> 1 then
    raise exception 'invite_member: expected lookup text once, found %, nothing patched', v_count;
  end if;
  execute replace(v_def, v_old, v_rep);
end $outer$;

-- 2. set_user_disabled: never leave a company without an active admin ---------------
create or replace function public.set_user_disabled(
  p_caller   uuid,
  p_user_id  uuid,
  p_disabled boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller_pa       boolean;
  v_caller_disabled boolean;
  v_current         boolean;
  v_tenant          uuid;
begin
  if p_disabled is null then
    raise exception 'disabled must be true or false'
      using errcode = 'PT400', hint = 'VALIDATION_ERROR';
  end if;

  select u.platform_admin, u.disabled into v_caller_pa, v_caller_disabled
    from public.users u where u.id = p_caller;
  if not found or not v_caller_pa or v_caller_disabled then
    raise exception 'only a platform admin may do this'
      using errcode = 'PT403', hint = 'FORBIDDEN';
  end if;

  if p_caller = p_user_id then
    raise exception 'you cannot disable your own account'
      using errcode = 'PT403', hint = 'FORBIDDEN';
  end if;

  select u.disabled into v_current from public.users u where u.id = p_user_id for update;
  if not found then
    raise exception 'user % not found', p_user_id
      using errcode = 'PT404', hint = 'RESOURCE_NOT_FOUND';
  end if;

  if v_current = p_disabled then
    return v_current;
  end if;

  -- Disabling: for every company where this person is the active admin, lock the
  -- company and make sure another active, not-disabled admin remains.
  if p_disabled then
    for v_tenant in
      select m.tenant_id from public.memberships m
       where m.user_id = p_user_id and m.role = 'company_admin' and m.status = 'active'
    loop
      perform public.attendance_lock_tenant(v_tenant, true);
      if not exists (
        select 1 from public.memberships m2
          join public.users au on au.id = m2.user_id
         where m2.tenant_id = v_tenant and m2.role = 'company_admin'
           and m2.status = 'active' and m2.user_id <> p_user_id and not au.disabled
      ) then
        raise exception 'a company must keep at least one active company_admin'
          using errcode = 'PT409', hint = 'LAST_ADMIN';
      end if;
    end loop;
  end if;

  update public.users u set disabled = p_disabled where u.id = p_user_id;

  perform public.write_audit_row(
    p_caller,
    case when p_disabled then 'user.disable' else 'user.enable' end,
    null,
    p_user_id,
    '{}'::jsonb
  );

  return p_disabled;
end;
$$;

revoke all on function public.set_user_disabled(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.set_user_disabled(uuid, uuid, boolean) to postgres, service_role;

-- 3. Row-level security helper: only active, not-disabled members --------------------
create or replace function private.user_in_my_company(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.memberships m
      join public.users u on u.id = m.user_id
     where m.user_id = p_user_id
       and m.tenant_id = (select private.current_company_id())
       and m.status = 'active'
       and not u.disabled
  )
$$;

-- 4. "Who did it" columns must name a platform admin or an active member of the row's company
create or replace function public.check_row_actor_in_company()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := nullif(to_jsonb(new) ->> TG_ARGV[0], '')::uuid;
  v_tenant uuid := nullif(to_jsonb(new) ->> TG_ARGV[1], '')::uuid;
begin
  if v_actor is null then
    return new;
  end if;
  -- Staff have no membership and may act on any company.
  if exists (select 1 from public.users u where u.id = v_actor and u.platform_admin) then
    return new;
  end if;
  if v_tenant is null or not exists (
    select 1 from public.memberships m
     where m.user_id = v_actor and m.tenant_id = v_tenant and m.status = 'active'
  ) then
    raise exception 'the acting person is not an active member of this company'
      using errcode = 'PT403', hint = 'FORBIDDEN';
  end if;
  return new;
end;
$$;

revoke all on function public.check_row_actor_in_company() from public, anon, authenticated;

create trigger leave_requests_actor_in_company
  before insert on public.leave_requests
  for each row execute function public.check_row_actor_in_company('created_by', 'tenant_id');
create trigger leave_events_actor_in_company
  before insert on public.leave_events
  for each row execute function public.check_row_actor_in_company('actor_id', 'tenant_id');
create trigger attendance_day_overrides_actor_in_company
  before insert on public.attendance_day_overrides
  for each row execute function public.check_row_actor_in_company('created_by', 'tenant_id');
create trigger attendance_corrections_actor_in_company
  before insert on public.attendance_corrections
  for each row execute function public.check_row_actor_in_company('actor_id', 'tenant_id');

-- 5. jobs: only a company admin writes the job row itself ----------------------------
drop policy jobs_member_insert on public.jobs;
drop policy jobs_member_update on public.jobs;
drop policy jobs_member_delete on public.jobs;

create policy jobs_member_insert on public.jobs for insert to authenticated
  with check (tenant_id = (select private.current_company_id())
              and (select private.current_member_role()) = 'company_admin');
create policy jobs_member_update on public.jobs for update to authenticated
  using (tenant_id = (select private.current_company_id())
         and (select private.current_member_role()) = 'company_admin')
  with check (tenant_id = (select private.current_company_id())
              and (select private.current_member_role()) = 'company_admin');
create policy jobs_member_delete on public.jobs for delete to authenticated
  using (tenant_id = (select private.current_company_id())
         and (select private.current_member_role()) = 'company_admin');
