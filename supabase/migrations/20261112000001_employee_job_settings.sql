-- Story 1 of spec-employee-created-jobs (CAP-1): per-employee job settings.
--
-- Plain-English contract:
--   can_create_jobs          may this employee create their own jobs? Default off.
--   job_approval_required    must the owner approve this employee's new jobs first?
--                            Default on (the safe choice).
--   Both live on the employee's membership row, so they are per person, per company.
--   The owner sets them with set_member_job_settings. Only a company_admin of that
--   company may set them; a platform admin with no membership in the company may not.
--   The target must be an active employee of that company.
--   Every real change writes one audit row in the same step, so the change and its
--   audit cannot diverge.
--   Settings are read when a job is created (story 2). They never change jobs
--   already pending.

alter table public.memberships
  add column can_create_jobs boolean not null default false,
  add column job_approval_required boolean not null default true;

-- =============================================================================
-- set_member_job_settings: owner sets an employee's two job switches.
--
-- Input:  caller, company, employee, the two new values.
-- Output: the membership id and the values now stored.
-- Errors: PT403 caller is not a company_admin of this company.
--         PT404 no active membership for that person in this company.
--         PT400 hint NOT_AN_EMPLOYEE, the target is an owner or viewer.
-- =============================================================================
create function public.set_member_job_settings(
  p_caller                uuid,
  p_tenant_id             uuid,
  p_member_user_id        uuid,
  p_can_create_jobs       boolean,
  p_job_approval_required boolean
)
returns table (
  member_id               uuid,
  can_create_jobs         boolean,
  job_approval_required   boolean
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_caller_disabled boolean;
  v_member          public.memberships%rowtype;
begin
  if p_can_create_jobs is null or p_job_approval_required is null then
    raise exception 'both job settings are required'
      using errcode = 'PT400', hint = 'VALIDATION_ERROR';
  end if;

  select u.disabled into v_caller_disabled
    from public.users u where u.id = p_caller;
  if not found or v_caller_disabled then
    raise exception 'caller is not allowed' using errcode = 'PT403', hint = 'FORBIDDEN';
  end if;

  -- Owner of THIS company only. The platform admin flag grants no owner job actions.
  if not exists (
    select 1 from public.memberships m
     where m.user_id = p_caller and m.tenant_id = p_tenant_id
       and m.status = 'active' and m.role = 'company_admin'
  ) then
    raise exception 'caller may not manage this company'
      using errcode = 'PT403', hint = 'FORBIDDEN';
  end if;

  select * into v_member from public.memberships m
   where m.user_id = p_member_user_id and m.tenant_id = p_tenant_id
   for update;
  if not found or v_member.status <> 'active' then
    raise exception 'member not found in this company'
      using errcode = 'PT404', hint = 'RESOURCE_NOT_FOUND';
  end if;

  if v_member.role <> 'employee' then
    raise exception 'job settings apply to employees only'
      using errcode = 'PT400', hint = 'NOT_AN_EMPLOYEE';
  end if;

  -- No change: return the stored values, write no audit row.
  if v_member.can_create_jobs = p_can_create_jobs
     and v_member.job_approval_required = p_job_approval_required then
    return query select v_member.id, v_member.can_create_jobs, v_member.job_approval_required;
    return;
  end if;

  update public.memberships m
     set can_create_jobs = p_can_create_jobs,
         job_approval_required = p_job_approval_required,
         updated_at = now()
   where m.id = v_member.id;

  perform public.write_audit_row(
    p_caller, 'member.job_settings_change', p_tenant_id, p_member_user_id,
    jsonb_build_object(
      'old_can_create_jobs', v_member.can_create_jobs,
      'new_can_create_jobs', p_can_create_jobs,
      'old_job_approval_required', v_member.job_approval_required,
      'new_job_approval_required', p_job_approval_required
    )
  );

  return query select v_member.id, p_can_create_jobs, p_job_approval_required;
end;
$$;

revoke all on function public.set_member_job_settings(uuid, uuid, uuid, boolean, boolean)
  from public, anon, authenticated;

grant execute on function public.set_member_job_settings(uuid, uuid, uuid, boolean, boolean)
  to postgres, service_role;
