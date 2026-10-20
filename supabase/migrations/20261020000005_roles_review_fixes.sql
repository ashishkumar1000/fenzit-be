-- Roles and access: fixes from the code review of steps 1 to 4.
--
-- Plain-English contract
--   * invite_member: two companies inviting the same new phone number at the
--     same moment can no longer produce a raw database error. The second one
--     gets DUPLICATE_RESOURCE. It also refuses a malformed phone number, an
--     unknown skill and a disabled person, and re-checks that the caller is
--     still an active admin after waiting for the company lock.
--   * change_member_role / remove_member: a disabled admin no longer counts as
--     "another admin" for the last-admin guard, and the caller is re-checked
--     after the lock.
--   * advance_workflow_step: an unknown actor no longer silences every alert.
--   * activity_logs: the job activity history is append-only again (decision 45
--     lets admin and employee add entries; nobody edits or deletes them).
--   * user_skills: a person edits their own skills (any role); a company admin
--     edits anyone's in the company. An employee can no longer edit a colleague's.
--
-- Spec: artifacts/implementation-artifacts/roles-and-access-spec.md.

-- 1. invite_member -----------------------------------------------------------------
create or replace function public.invite_member(
  p_caller uuid, p_tenant_id uuid, p_country_code text, p_phone_number text,
  p_name text, p_role text, p_skill_ids uuid[] default '{}'::uuid[]
)
returns table(member_id uuid, member_user_id uuid, member_employee_code text,
              was_user_created boolean, was_reactivated boolean)
language plpgsql
security definer
set search_path to ''
as $function$
#variable_conflict use_column
declare
  v_caller_pa       boolean;
  v_caller_disabled boolean;
  v_user            public.users%rowtype;
  v_member          public.memberships%rowtype;
  v_user_created    boolean := false;
  v_reactivated     boolean := false;
  v_seq             int;
  v_constraint      text;
begin
  if p_role is null or p_role not in ('company_admin', 'employee', 'viewer') then
    raise exception 'role must be company_admin, employee or viewer'
      using errcode = 'PT400', hint = 'VALIDATION_ERROR';
  end if;
  if p_country_code is null or p_country_code !~ '^\+[0-9]{1,4}$'
     or p_phone_number is null or p_phone_number !~ '^[0-9]{6,15}$' then
    raise exception 'country code must look like +91 and phone number must be 6 to 15 digits'
      using errcode = 'PT400', hint = 'VALIDATION_ERROR';
  end if;
  if exists (
    select 1 from unnest(coalesce(p_skill_ids, '{}'::uuid[])) s
     where s is null or not exists (select 1 from public.skills k where k.id = s)
  ) then
    raise exception 'one or more skills do not exist'
      using errcode = 'PT400', hint = 'VALIDATION_ERROR';
  end if;

  select u.platform_admin, u.disabled into v_caller_pa, v_caller_disabled
    from public.users u where u.id = p_caller;
  if not found or v_caller_disabled then
    raise exception 'caller is not allowed' using errcode = 'PT403', hint = 'FORBIDDEN';
  end if;
  if not v_caller_pa and not exists (
    select 1 from public.memberships m
     where m.user_id = p_caller and m.tenant_id = p_tenant_id
       and m.status = 'active' and m.role = 'company_admin'
  ) then
    raise exception 'caller may not manage this company'
      using errcode = 'PT403', hint = 'FORBIDDEN';
  end if;

  if not exists (select 1 from public.tenants t where t.id = p_tenant_id) then
    raise exception 'company % not found', p_tenant_id
      using errcode = 'PT404', hint = 'RESOURCE_NOT_FOUND';
  end if;

  -- One invite per phone number at a time, across companies, then the company lock.
  perform pg_advisory_xact_lock(hashtext('invite:' || p_country_code || p_phone_number));
  perform public.attendance_lock_tenant(p_tenant_id, true);

  -- The caller may have been demoted or removed while we waited for the locks.
  if not v_caller_pa and not exists (
    select 1 from public.memberships m
      join public.users cu on cu.id = m.user_id
     where m.user_id = p_caller and m.tenant_id = p_tenant_id
       and m.status = 'active' and m.role = 'company_admin' and not cu.disabled
  ) then
    raise exception 'caller may not manage this company'
      using errcode = 'PT403', hint = 'FORBIDDEN';
  end if;

  begin
    select * into v_user from public.users u
     where u.country_code = p_country_code and u.phone_number = p_phone_number
     order by u.created_at
     limit 1;

    if found then
      if v_user.platform_admin then
        raise exception 'a platform admin cannot be a company member'
          using errcode = 'PT400', hint = 'VALIDATION_ERROR';
      end if;
      if v_user.disabled then
        raise exception 'this person is disabled'
          using errcode = 'PT403', hint = 'FORBIDDEN';
      end if;
      if exists (
        select 1 from public.memberships m
         where m.user_id = v_user.id and m.status <> 'removed'
      ) then
        raise exception 'this person already belongs to a company'
          using errcode = 'PT409', hint = 'DUPLICATE_RESOURCE';
      end if;
      if v_user.name is null and nullif(btrim(p_name), '') is not null then
        update public.users u set name = btrim(p_name) where u.id = v_user.id;
      end if;
    else
      insert into public.users (name, country_code, phone_number)
      values (nullif(btrim(p_name), ''), p_country_code, p_phone_number)
      returning * into v_user;
      v_user_created := true;
    end if;

    select * into v_member from public.memberships m
     where m.user_id = v_user.id and m.tenant_id = p_tenant_id and m.status = 'removed'
     for update;

    if found then
      update public.memberships m
         set status = 'invited', role = p_role, invited_by = p_caller
       where m.id = v_member.id
      returning * into v_member;
      v_reactivated := true;
    else
      insert into public.employee_sequences (tenant_id, last_seq)
      values (p_tenant_id, 1)
      on conflict (tenant_id)
      do update set last_seq = public.employee_sequences.last_seq + 1
      returning last_seq into v_seq;

      insert into public.memberships (user_id, tenant_id, role, status, employee_code, invited_by)
      values (
        v_user.id, p_tenant_id, p_role, 'invited',
        'EMP-' || lpad(v_seq::text, greatest(3, length(v_seq::text)), '0'),
        p_caller
      )
      returning * into v_member;
    end if;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint in ('users_phone_key', 'memberships_one_live_per_user') then
      raise exception 'this person already belongs to a company'
        using errcode = 'PT409', hint = 'DUPLICATE_RESOURCE';
    end if;
    raise;
  end;

  insert into public.user_skills (user_id, skill_id)
  select v_user.id, s from unnest(coalesce(p_skill_ids, '{}'::uuid[])) as s
  on conflict do nothing;

  perform public.write_audit_row(
    p_caller, 'member.invite', p_tenant_id, v_user.id,
    jsonb_build_object('role', p_role, 'reactivated', v_reactivated)
  );

  return query
    select v_member.id, v_user.id, v_member.employee_code, v_user_created, v_reactivated;
end;
$function$;

-- 2. change_member_role ------------------------------------------------------------
create or replace function public.change_member_role(
  p_caller uuid, p_tenant_id uuid, p_member_user_id uuid, p_new_role text
)
returns table(member_id uuid, old_role text, new_role text)
language plpgsql
security definer
set search_path to ''
as $function$
#variable_conflict use_column
declare
  v_caller_pa       boolean;
  v_caller_disabled boolean;
  v_member          public.memberships%rowtype;
  v_old_role        text;
begin
  if p_new_role is null or p_new_role not in ('company_admin', 'employee', 'viewer') then
    raise exception 'role must be company_admin, employee or viewer'
      using errcode = 'PT400', hint = 'VALIDATION_ERROR';
  end if;

  select u.platform_admin, u.disabled into v_caller_pa, v_caller_disabled
    from public.users u where u.id = p_caller;
  if not found or v_caller_disabled then
    raise exception 'caller is not allowed' using errcode = 'PT403', hint = 'FORBIDDEN';
  end if;
  if not v_caller_pa and not exists (
    select 1 from public.memberships m
     where m.user_id = p_caller and m.tenant_id = p_tenant_id
       and m.status = 'active' and m.role = 'company_admin'
  ) then
    raise exception 'caller may not manage this company'
      using errcode = 'PT403', hint = 'FORBIDDEN';
  end if;

  if p_caller = p_member_user_id then
    raise exception 'you cannot change your own role'
      using errcode = 'PT403', hint = 'FORBIDDEN';
  end if;

  if not exists (select 1 from public.tenants t where t.id = p_tenant_id) then
    raise exception 'company % not found', p_tenant_id
      using errcode = 'PT404', hint = 'RESOURCE_NOT_FOUND';
  end if;

  perform public.attendance_lock_tenant(p_tenant_id, true);

  -- The caller may have been demoted or removed while we waited for the lock.
  if not v_caller_pa and not exists (
    select 1 from public.memberships m
      join public.users cu on cu.id = m.user_id
     where m.user_id = p_caller and m.tenant_id = p_tenant_id
       and m.status = 'active' and m.role = 'company_admin' and not cu.disabled
  ) then
    raise exception 'caller may not manage this company'
      using errcode = 'PT403', hint = 'FORBIDDEN';
  end if;

  select * into v_member from public.memberships m
   where m.user_id = p_member_user_id and m.tenant_id = p_tenant_id
     and m.status <> 'removed'
   for update;
  if not found then
    raise exception 'member not found in this company'
      using errcode = 'PT404', hint = 'RESOURCE_NOT_FOUND';
  end if;

  v_old_role := v_member.role;
  if v_old_role = p_new_role then
    return query select v_member.id, v_old_role, p_new_role;
    return;
  end if;

  -- Only another admin who can actually sign in counts.
  if v_old_role = 'company_admin' and v_member.status = 'active'
     and not exists (
       select 1 from public.memberships m
         join public.users au on au.id = m.user_id
        where m.tenant_id = p_tenant_id and m.role = 'company_admin'
          and m.status = 'active' and m.id <> v_member.id and not au.disabled
     ) then
    raise exception 'a company must keep at least one active company_admin'
      using errcode = 'PT409', hint = 'LAST_ADMIN';
  end if;

  update public.memberships m set role = p_new_role where m.id = v_member.id;

  perform public.write_audit_row(
    p_caller, 'member.role_change', p_tenant_id, p_member_user_id,
    jsonb_build_object('old_role', v_old_role, 'new_role', p_new_role)
  );

  return query select v_member.id, v_old_role, p_new_role;
end;
$function$;

-- 3. remove_member -----------------------------------------------------------------
create or replace function public.remove_member(
  p_caller uuid, p_tenant_id uuid, p_member_user_id uuid
)
returns table(member_id uuid, old_role text)
language plpgsql
security definer
set search_path to ''
as $function$
#variable_conflict use_column
declare
  v_caller_pa       boolean;
  v_caller_disabled boolean;
  v_member          public.memberships%rowtype;
begin
  select u.platform_admin, u.disabled into v_caller_pa, v_caller_disabled
    from public.users u where u.id = p_caller;
  if not found or v_caller_disabled then
    raise exception 'caller is not allowed' using errcode = 'PT403', hint = 'FORBIDDEN';
  end if;
  if not v_caller_pa and not exists (
    select 1 from public.memberships m
     where m.user_id = p_caller and m.tenant_id = p_tenant_id
       and m.status = 'active' and m.role = 'company_admin'
  ) then
    raise exception 'caller may not manage this company'
      using errcode = 'PT403', hint = 'FORBIDDEN';
  end if;

  if p_caller = p_member_user_id then
    raise exception 'you cannot remove yourself'
      using errcode = 'PT403', hint = 'FORBIDDEN';
  end if;

  if not exists (select 1 from public.tenants t where t.id = p_tenant_id) then
    raise exception 'company % not found', p_tenant_id
      using errcode = 'PT404', hint = 'RESOURCE_NOT_FOUND';
  end if;

  perform public.attendance_lock_tenant(p_tenant_id, true);

  -- The caller may have been demoted or removed while we waited for the lock.
  if not v_caller_pa and not exists (
    select 1 from public.memberships m
      join public.users cu on cu.id = m.user_id
     where m.user_id = p_caller and m.tenant_id = p_tenant_id
       and m.status = 'active' and m.role = 'company_admin' and not cu.disabled
  ) then
    raise exception 'caller may not manage this company'
      using errcode = 'PT403', hint = 'FORBIDDEN';
  end if;

  select * into v_member from public.memberships m
   where m.user_id = p_member_user_id and m.tenant_id = p_tenant_id
     and m.status <> 'removed'
   for update;
  if not found then
    raise exception 'member not found in this company'
      using errcode = 'PT404', hint = 'RESOURCE_NOT_FOUND';
  end if;

  -- Only another admin who can actually sign in counts.
  if v_member.role = 'company_admin' and v_member.status = 'active'
     and not exists (
       select 1 from public.memberships m
         join public.users au on au.id = m.user_id
        where m.tenant_id = p_tenant_id and m.role = 'company_admin'
          and m.status = 'active' and m.id <> v_member.id and not au.disabled
     ) then
    raise exception 'a company must keep at least one active company_admin'
      using errcode = 'PT409', hint = 'LAST_ADMIN';
  end if;

  update public.memberships m set status = 'removed' where m.id = v_member.id;

  perform public.write_audit_row(
    p_caller, 'member.remove', p_tenant_id, p_member_user_id,
    jsonb_build_object('old_role', v_member.role, 'old_status', v_member.status)
  );

  return query select v_member.id, v_member.role;
end;
$function$;

-- 4. advance_workflow_step: only the alert line changes (null-safe actor check) ----
do $$
declare
  v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'advance_workflow_step';
  if position('AND m.user_id <> p_actor_id' in v_def) = 0 then
    raise exception 'advance_workflow_step does not have the expected alert line';
  end if;
  execute replace(v_def, 'AND m.user_id <> p_actor_id', 'AND m.user_id IS DISTINCT FROM p_actor_id');
end $$;

-- 5. Job activity history is append-only (admin and employee may add, nobody edits) --
drop policy activity_logs_member_update on public.activity_logs;
drop policy activity_logs_member_delete on public.activity_logs;

-- 6. user_skills: own skills for anyone, anyone's for a company admin --------------
drop policy user_skills_member_write on public.user_skills;
create policy user_skills_member_write on public.user_skills
  for all to authenticated
  using (
    user_id = nullif(auth.jwt() ->> 'sub', '')::uuid
    or ((select private.user_in_my_company(user_skills.user_id))
        and (select private.current_member_role()) = 'company_admin')
  )
  with check (
    user_id = nullif(auth.jwt() ->> 'sub', '')::uuid
    or ((select private.user_in_my_company(user_skills.user_id))
        and (select private.current_member_role()) = 'company_admin')
  );
