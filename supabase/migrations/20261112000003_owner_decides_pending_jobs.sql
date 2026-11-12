-- Story 3 of spec-employee-created-jobs (CAP-5, decisions only): owner approves or
-- rejects a pending employee job.
--
-- Plain-English contract:
--   approve  pending_approval -> scheduled. The job is now the creator's assigned work.
--   reject   pending_approval -> rejected. The job is not assigned work. The creator
--            keeps it in their history. The reason is optional.
--   Only the owner of THIS company may decide (the platform admin flag grants nothing).
--   A decision is atomic: the job row is locked, checked and changed in one step.
--   Only a pending job takes a decision. Any later decision is refused with a
--   conflict (JOB_NOT_PENDING), so exactly one decision wins a race.
--   Every decision writes one activity row in the same step.
--   Notifications are story 5, not this migration.

alter table public.jobs
  add column decided_by uuid references public.users (id) on delete restrict,
  add column decided_at timestamptz,
  add column rejection_reason text
    constraint jobs_rejection_reason_length check (
      rejection_reason is null or length(rejection_reason) between 1 and 500
    );

alter table public.jobs drop constraint jobs_status_check;
alter table public.jobs
  add constraint jobs_status_check check (
    status = any (array['scheduled', 'in_progress', 'completed', 'cancelled',
                        'pending_approval', 'rejected']::text[])
  );

-- A rejected job always records who decided and when.
alter table public.jobs
  add constraint jobs_rejected_has_decision_check check (
    status <> 'rejected' or (decided_by is not null and decided_at is not null)
  );

-- =============================================================================
-- decide_pending_job: owner approves or rejects one pending job.
--
-- Input:  caller, company, job, decision ('approve' | 'reject'), optional reason.
-- Output: the job row after the decision.
-- Errors: PT400 decision not approve/reject, or reason over 500 characters.
--         PT403 caller is not an active company_admin of this company.
--         PT404 no job with that id in this company.
--         PT409 hint JOB_NOT_PENDING: the job already left pending.
-- =============================================================================
create function public.decide_pending_job(
  p_caller    uuid,
  p_tenant_id uuid,
  p_job_id    uuid,
  p_decision  text,
  p_reason    text default null
)
returns setof public.jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller_disabled boolean;
  v_job             public.jobs%rowtype;
  -- Blank means no reason: spaces, tabs, carriage returns and newlines all count.
  v_reason          text := nullif(btrim(p_reason, E' \t\r\n'), '');
begin
  if p_decision is null or p_decision not in ('approve', 'reject') then
    raise exception 'decision must be approve or reject'
      using errcode = 'PT400', hint = 'VALIDATION_ERROR';
  end if;
  if v_reason is not null and length(v_reason) > 500 then
    raise exception 'reason must be 500 characters or fewer'
      using errcode = 'PT400', hint = 'VALIDATION_ERROR';
  end if;

  select u.disabled into v_caller_disabled
    from public.users u where u.id = p_caller;
  if not found or v_caller_disabled then
    raise exception 'caller is not allowed' using errcode = 'PT403', hint = 'FORBIDDEN';
  end if;

  if not exists (
    select 1 from public.memberships m
     where m.user_id = p_caller and m.tenant_id = p_tenant_id
       and m.status = 'active' and m.role = 'company_admin'
  ) then
    raise exception 'caller may not manage this company'
      using errcode = 'PT403', hint = 'FORBIDDEN';
  end if;

  select * into v_job from public.jobs j
   where j.id = p_job_id and j.tenant_id = p_tenant_id
   for update;
  if not found then
    raise exception 'job not found in this company'
      using errcode = 'PT404', hint = 'RESOURCE_NOT_FOUND';
  end if;

  if v_job.status <> 'pending_approval' then
    raise exception 'job is no longer waiting for approval'
      using errcode = 'PT409', hint = 'JOB_NOT_PENDING';
  end if;

  if p_decision = 'approve' then
    update public.jobs j
       set status = 'scheduled', decided_by = p_caller, decided_at = now(),
           rejection_reason = null, updated_at = now()
     where j.id = p_job_id;
  else
    update public.jobs j
       set status = 'rejected', decided_by = p_caller, decided_at = now(),
           rejection_reason = v_reason, updated_at = now()
     where j.id = p_job_id;
  end if;

  insert into public.activity_logs (job_id, tenant_id, event_type, actor_id)
  values (p_job_id, p_tenant_id,
          case when p_decision = 'approve' then 'job_approved' else 'job_rejected' end,
          p_caller);

  return query select * from public.jobs j where j.id = p_job_id;
end;
$$;

revoke all on function public.decide_pending_job(uuid, uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.decide_pending_job(uuid, uuid, uuid, text, text)
  to postgres, service_role;
