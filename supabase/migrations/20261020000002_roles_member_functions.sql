-- Roles and access, step 1b: the five all-or-nothing functions.
--
-- Why functions: each of these changes several rows that must succeed or fail
-- together (for example "change the role AND write the audit row"). The REST
-- client cannot run several steps as one unit, so the database does it.
--
-- How they are used: the backend checks the caller's permission first. Each
-- function then re-checks the data rules itself, so a bug in the backend cannot
-- bypass them. Only the backend (service role) may run them. Each runs as one
-- step and writes its audit row in that same step.
--
-- Errors follow the repo's convention: errcode PT4xx plus a hint holding the
-- API error code (FORBIDDEN, VALIDATION_ERROR, RESOURCE_NOT_FOUND,
-- DUPLICATE_RESOURCE, LAST_ADMIN). The backend turns the hint into `error_code`.
--
-- The caller check used by the member functions, in plain English:
--   a platform admin may act on any company; otherwise the caller must be an
--   ACTIVE company_admin of that same company. A disabled caller is refused.

-- =============================================================================
-- write_audit_row: the shared "who did what, where, when" step.
--
-- Input:  actor, action text (e.g. 'member.invite'), company (or none for a
--         platform-wide action), the person acted on (optional), details.
-- Refuses: an unknown actor, company or target; a blank action; and a caller
--         who is neither a platform admin nor an active member of the named
--         company (so the backend cannot forge an entry for someone else).
-- Result: the new audit row's id. It records whether the actor was acting as
--         platform admin at that moment.
-- =============================================================================
create function public.write_audit_row(
  p_actor       uuid,
  p_action      text,
  p_tenant_id   uuid,
  p_target_user uuid default null,
  p_details     jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_is_pa boolean;
  v_id    uuid;
begin
  if p_action is null or btrim(p_action) = '' then
    raise exception 'audit action is required'
      using errcode = 'PT400', hint = 'VALIDATION_ERROR';
  end if;

  select u.platform_admin into v_is_pa from public.users u where u.id = p_actor;
  if not found then
    raise exception 'audit actor % not found', p_actor
      using errcode = 'PT404', hint = 'RESOURCE_NOT_FOUND';
  end if;

  if p_tenant_id is not null
     and not exists (select 1 from public.tenants t where t.id = p_tenant_id) then
    raise exception 'audit company % not found', p_tenant_id
      using errcode = 'PT404', hint = 'RESOURCE_NOT_FOUND';
  end if;

  if p_target_user is not null
     and not exists (select 1 from public.users u where u.id = p_target_user) then
    raise exception 'audit target user % not found', p_target_user
      using errcode = 'PT404', hint = 'RESOURCE_NOT_FOUND';
  end if;

  -- A company-side actor must name their own company and be active in it.
  if not v_is_pa then
    if p_tenant_id is null
       or not exists (
         select 1 from public.memberships m
          where m.user_id = p_actor
            and m.tenant_id = p_tenant_id
            and m.status = 'active'
       ) then
      raise exception 'audit actor is not allowed to write for this company'
        using errcode = 'PT403', hint = 'FORBIDDEN';
    end if;
  end if;

  insert into public.audit_log (
    actor_user_id, actor_is_platform_admin, tenant_id, action, target_user_id, details
  )
  values (
    p_actor, v_is_pa, p_tenant_id, btrim(p_action), p_target_user,
    coalesce(p_details, '{}'::jsonb)
  )
  returning id into v_id;

  return v_id;
end;
$$;

-- =============================================================================
-- invite_member: add a person to a company.
--
-- Input:  caller, company, the person's country code and phone, name, role
--         (company_admin, employee or viewer) and optional skill ids.
-- Refuses: a role outside those three; a caller who may not manage that
--         company; a company that does not exist; a person who has the
--         platform_admin flag; a person who already has an invited or active
--         membership anywhere (DUPLICATE_RESOURCE).
-- Steps:  1. Lock the company's memberships.
--         2. Find the person by phone, or create an identity-only user.
--         3. If this person was REMOVED from this same company before, bring
--            that row back as 'invited' with the new role. It keeps its
--            employee code and history. Otherwise create a new 'invited'
--            membership and give it the company's next employee code.
--         4. Attach the skills.
--         5. Write the audit row.
-- Result: the membership id, the user id, the employee code, and whether the
--         user was created and whether an old membership was brought back.
-- =============================================================================
create function public.invite_member(
  p_caller       uuid,
  p_tenant_id    uuid,
  p_country_code text,
  p_phone_number text,
  p_name         text,
  p_role         text,
  p_skill_ids    uuid[] default '{}'
)
returns table (
  member_id            uuid,
  member_user_id       uuid,
  member_employee_code text,
  was_user_created     boolean,
  was_reactivated      boolean
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_caller_pa       boolean;
  v_caller_disabled boolean;
  v_user            public.users%rowtype;
  v_member          public.memberships%rowtype;
  v_user_created    boolean := false;
  v_reactivated     boolean := false;
  v_seq             int;
begin
  if p_role is null or p_role not in ('company_admin', 'employee', 'viewer') then
    raise exception 'role must be company_admin, employee or viewer'
      using errcode = 'PT400', hint = 'VALIDATION_ERROR';
  end if;
  if coalesce(btrim(p_country_code), '') = '' or coalesce(btrim(p_phone_number), '') = '' then
    raise exception 'country code and phone number are required'
      using errcode = 'PT400', hint = 'VALIDATION_ERROR';
  end if;

  -- Caller check.
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

  perform public.attendance_lock_tenant(p_tenant_id, true);

  select * into v_user from public.users u
   where u.country_code = p_country_code and u.phone_number = p_phone_number
   order by u.created_at
   limit 1;

  if found then
    if v_user.platform_admin then
      raise exception 'a platform admin cannot be a company member'
        using errcode = 'PT400', hint = 'VALIDATION_ERROR';
    end if;
    -- Any invited or active membership, in any company, blocks the invite.
    if exists (
      select 1 from public.memberships m
       where m.user_id = v_user.id and m.status <> 'removed'
    ) then
      raise exception 'this person already belongs to a company'
        using errcode = 'PT409', hint = 'DUPLICATE_RESOURCE';
    end if;
    -- Fill in a missing name, never overwrite one.
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
$$;

-- =============================================================================
-- change_member_role: promote or demote a member.
--
-- Input:  caller, company, the member's user id, the new role.
-- Refuses: a role outside company_admin / employee / viewer; a caller who may
--         not manage the company; the caller changing their OWN role; a member
--         who is not in the company (or was removed); and a change that would
--         leave the company with no active company_admin (LAST_ADMIN).
-- Steps:  lock the company's memberships first, so two admins demoting each
--         other at the same moment cannot both pass; update the role; write
--         the audit row with the old and new role. A change to the same role
--         does nothing and writes nothing.
-- =============================================================================
create function public.change_member_role(
  p_caller         uuid,
  p_tenant_id      uuid,
  p_member_user_id uuid,
  p_new_role       text
)
returns table (
  member_id uuid,
  old_role  text,
  new_role  text
)
language plpgsql
security definer
set search_path = ''
as $$
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

  if v_old_role = 'company_admin' and v_member.status = 'active'
     and not exists (
       select 1 from public.memberships m
        where m.tenant_id = p_tenant_id and m.role = 'company_admin'
          and m.status = 'active' and m.id <> v_member.id
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
$$;

-- =============================================================================
-- remove_member: take a person out of a company.
--
-- Input:  caller, company, the member's user id.
-- Refuses: a caller who may not manage the company; the caller removing
--         THEMSELVES; a member who is not in the company (or already removed);
--         and removing the last active company_admin (LAST_ADMIN).
-- Steps:  same company lock as change_member_role; set the membership to
--         'removed' (the row is never deleted, so their jobs, attendance and
--         leave stay valid); write the audit row.
-- =============================================================================
create function public.remove_member(
  p_caller         uuid,
  p_tenant_id      uuid,
  p_member_user_id uuid
)
returns table (
  member_id uuid,
  old_role  text
)
language plpgsql
security definer
set search_path = ''
as $$
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

  select * into v_member from public.memberships m
   where m.user_id = p_member_user_id and m.tenant_id = p_tenant_id
     and m.status <> 'removed'
   for update;
  if not found then
    raise exception 'member not found in this company'
      using errcode = 'PT404', hint = 'RESOURCE_NOT_FOUND';
  end if;

  if v_member.role = 'company_admin' and v_member.status = 'active'
     and not exists (
       select 1 from public.memberships m
        where m.tenant_id = p_tenant_id and m.role = 'company_admin'
          and m.status = 'active' and m.id <> v_member.id
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
$$;

-- =============================================================================
-- set_user_disabled: switch a person off (or back on). Platform admin only.
--
-- Input:  caller, the person, true to disable / false to enable.
-- Refuses: a caller without the platform_admin flag (or who is disabled);
--         the caller disabling their OWN account; an unknown person.
-- Steps:  set the flag; write the audit row (platform-wide, no company). Setting
--         the value it already has does nothing and writes nothing.
-- Effect: a disabled person gets the same generic 401 as a wrong password, at
--         login and on every later request (enforced by the backend guard and
--         by the RLS helpers).
-- Result: the person's disabled flag after the call.
-- =============================================================================
create function public.set_user_disabled(
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

-- Only the database owner and the backend's service role may run these.
revoke all on function public.write_audit_row(uuid, text, uuid, uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.invite_member(uuid, uuid, text, text, text, text, uuid[])
  from public, anon, authenticated;
revoke all on function public.change_member_role(uuid, uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.remove_member(uuid, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.set_user_disabled(uuid, uuid, boolean)
  from public, anon, authenticated;

grant execute on function public.write_audit_row(uuid, text, uuid, uuid, jsonb)
  to postgres, service_role;
grant execute on function public.invite_member(uuid, uuid, text, text, text, text, uuid[])
  to postgres, service_role;
grant execute on function public.change_member_role(uuid, uuid, uuid, text)
  to postgres, service_role;
grant execute on function public.remove_member(uuid, uuid, uuid)
  to postgres, service_role;
grant execute on function public.set_user_disabled(uuid, uuid, boolean)
  to postgres, service_role;
