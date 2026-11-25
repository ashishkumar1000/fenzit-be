-- Invite EMP-code collision: root-cause fix, 2026-11-25 (prod incident:
-- every invite answered 409 "This person already belongs to a company" for
-- brand-new numbers).
--
-- What happened
--   invite_member minted 'EMP-' || lpad(employee_sequences.last_seq) and
--   inserted it straight into memberships. Memberships whose codes were written
--   by anything other than the invite path (QA fixture seeding inserts rows
--   with explicit codes; owners hand-set codes since CAP-13) leave the counter
--   behind those codes. The next invite then tried to mint an ALREADY TAKEN
--   code — memberships_tenant_employee_code_key is not in the function's
--   unique-violation whitelist, so the raw 23505 escaped, the API's blanket
--   "23505 means duplicate phone" mapping turned it into 409 "This person
--   already belongs to a company", and the app blamed the phone number. The
--   failed transaction also rolled the counter bump back, so the same code was
--   retried on every invite: permanent, and independent of the number typed.
--
-- What this migration does
--   1. Restores invite_member and set_employee_code to their exact pre-incident
--      bodies (invite_member = migration 20261020000008 with the 20261020000009
--      "for update" on the person lookup; set_employee_code = 20261020000003).
--      An earlier draft of this migration rewrote both bodies in PL/pgSQL
--      (loop-minting); that draft was applied to prod and is REVERTED here per
--      the standing stored-procedure rule: database logic belongs in the
--      backend TypeScript, where it is reviewable and jest-testable. The
--      drift-proof minting now lives in AuthService.inviteMember
--      (pgPool.withTransaction, the setActive pattern), which mints the next
--      FREE code — bump the counter, check the code against this company's
--      memberships, bump again if taken — so drift heals itself on the first
--      invite and hand-set codes are stepped over forever.
--      Do NOT call invite_member from new code: once the backend rewrite is
--      deployed it has no callers, and a follow-up migration drops it. Its
--      single-mint body still carries the drift risk that caused the incident.
--   2. Keeps the counter heal from the draft (plain SQL, monotonic, idempotent):
--      every tenant's counter moves up to its highest used code number, so the
--      first post-deploy invite starts clean and the restored single-mint
--      bodies cannot collide on the data that exists today.
--
-- Concurrency: unchanged. The counter upsert row-locks per tenant and the
-- invite holds the phone advisory lock and the tenant advisory lock, so two
-- invites cannot mint the same code.

-- 1. invite_member: restored pre-incident body -----------------------------------
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
     limit 1
     for update;

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

-- Grants are unchanged from migration 20261020000002 (restated so the file is
-- self-contained; the revoked draft's grants were identical).
revoke all on function public.invite_member(uuid, uuid, text, text, text, text, uuid[])
  from public, anon, authenticated;
grant execute on function public.invite_member(uuid, uuid, text, text, text, text, uuid[])
  to postgres, service_role;

-- 2. set_employee_code trigger: restored pre-incident body -----------------------
create or replace function public.set_employee_code()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_seq int;
begin
  -- A caller that already supplied one (invite_member does) keeps it.
  if new.employee_code is not null then
    return new;
  end if;

  insert into public.employee_sequences (tenant_id, last_seq)
  values (new.tenant_id, 1)
  on conflict (tenant_id)
  do update set last_seq = public.employee_sequences.last_seq + 1
  returning last_seq into v_seq;

  new.employee_code := 'EMP-' || lpad(v_seq::text, greatest(3, length(v_seq::text)), '0');
  return new;
end;
$function$;

revoke execute on function public.set_employee_code() from public;
revoke execute on function public.set_employee_code() from anon;
revoke execute on function public.set_employee_code() from authenticated;

-- 3. Heal every tenant's counter to its highest used code number ------------------
-- The data fix itself (this is what un-broke invites before the backend
-- rewrite ships). Monotonic and idempotent: a counter already ahead of its
-- codes is left alone (its numbers were burned by removed memberships).
insert into public.employee_sequences (tenant_id, last_seq)
select t.id, 0 from public.tenants t
on conflict (tenant_id) do nothing;

update public.employee_sequences es
set last_seq = sub.max_num
from (
  select m.tenant_id, max(nullif(regexp_replace(m.employee_code, '\D', '', 'g'), '')::int) as max_num
  from public.memberships m
  where m.employee_code ~ '^EMP-[0-9]+$'
    -- int4 ceiling: a hand-set code with 10+ digits would overflow the cast
    -- and abort the whole migration; such a code cannot exist in practice,
    -- but skipping it is free.
    and length(regexp_replace(m.employee_code, '\D', '', 'g')) <= 9
  group by m.tenant_id
) sub
where es.tenant_id = sub.tenant_id
  and es.last_seq < sub.max_num;
