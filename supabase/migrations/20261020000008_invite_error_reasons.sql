-- Invite error reasons (bug fix from the phone test, 2026-10-20).
--
-- Before: a platform admin's number and a number already in the SAME company
-- both came back as generic errors, so the app showed the wrong copy:
--   * a platform admin was refused as VALIDATION_ERROR ("the request is not
--     valid"), so the app said "Check the phone number and skills";
--   * any live membership was DUPLICATE_RESOURCE, so the app said "already
--     part of your team" even when the person was in ANOTHER company.
--
-- After: the database names the reason in the error hint, and the API maps
-- each hint to its own error code:
--   * PLATFORM_STAFF_NOT_MEMBER  — the number belongs to Fenzit staff (400)
--   * ALREADY_IN_TEAM            — the person is already in THIS company (409)
--   * DUPLICATE_RESOURCE         — the person belongs to ANOTHER company (409),
--                                  unchanged, and still the race fallback.
--
-- Only the two hints and the one new branch change. Everything else in
-- invite_member is byte-for-byte the migration 5 body.

create or replace function public.invite_member(
  p_caller uuid,
  p_tenant_id uuid,
  p_country_code text,
  p_phone_number text,
  p_name text,
  p_role text,
  p_skill_ids uuid[] default '{}'::uuid[]
)
returns table (
  member_id uuid,
  member_user_id uuid,
  member_employee_code text,
  was_user_created boolean,
  was_reactivated boolean
)
language plpgsql
security definer
set search_path = ''
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
  if not exists (select 1 from public.country_codes c where c.dial_code = p_country_code) then
    raise exception 'country code % is not supported', p_country_code
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
          using errcode = 'PT400', hint = 'PLATFORM_STAFF_NOT_MEMBER';
      end if;
      if v_user.disabled then
        raise exception 'this person is disabled'
          using errcode = 'PT403', hint = 'FORBIDDEN';
      end if;
      if exists (
        select 1 from public.memberships m
         where m.user_id = v_user.id and m.tenant_id = p_tenant_id and m.status <> 'removed'
      ) then
        raise exception 'this person is already in this company'
          using errcode = 'PT409', hint = 'ALREADY_IN_TEAM';
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
