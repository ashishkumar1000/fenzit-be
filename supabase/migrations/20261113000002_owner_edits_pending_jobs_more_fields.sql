-- Epic 22 review fixes for update_job_with_log (CAP-5 owner edits, story 4).
-- Supersedes the function body from 20261112000004_owner_edits_pending_jobs.
--
-- Plain-English contract for update_job_with_log:
--   scheduled jobs    Owner edits fields as before. Cancel still works.
--   pending jobs      Owner edits description, times, notes, priority — and now
--                     also the service location, the skill and the customer.
--                     Owner may also cancel the pending job (it ends as
--                     'cancelled', and the owner is recorded as the decider,
--                     like a rejection). The assignee cannot change while
--                     pending: the job stays with its creator until it is
--                     approved, so the creator keeps access.
--   employee jobs     A job created by an employee of this company takes owner
--                     edits ONLY while it is pending approval (CAP-5). After a
--                     decision it is read-only for edits, refused with the same
--                     PT409 JOB_NOT_MODIFIABLE the app already answers — this
--                     rule now also lives in the database, so no future caller
--                     can bypass it. The row is locked above, so this cannot
--                     race a decision.
--   any other job     Refused with PT409 (JOB_NOT_MODIFIABLE). Rejected jobs stay
--                     read-only, so an owner can never revive one by editing it.
--   edits             A non-null param replaces the column (COALESCE, PATCH
--                     semantics); an explicit null keeps the current value and is
--                     not a change. A moved customer must belong to this company
--                     (PT404, the same not-found answer the create flow gives —
--                     a cross-tenant customer id is never accepted). A moved
--                     skill must have a workflow template, exactly like creation
--                     stamps one (PT400); when the skill changes, the job also
--                     takes that skill's latest template so the stamped work
--                     stays in step with the skill. The service location is
--                     plain text — no lookup.
--   audit             Every save that changes something writes ONE 'job_edited' row
--                     in the same step. Its metadata lists each changed field as
--                     {before, after}. A save with no real change writes nothing and
--                     does not bump updated_at. A reassignment also writes the
--                     existing 'job_reassigned' row, so older timelines still read.
--
-- The signature grows (10 → 13 params; the three new ones default to null, so
-- older callers that pass 10 inputs still work). The old 10-param function is
-- dropped first so no stale signature lingers behind the replacement.

drop function if exists public.update_job_with_log(
  uuid, uuid, uuid, boolean, text, timestamptz, timestamptz, text, uuid, text
);

create function public.update_job_with_log(
  p_job_id               uuid,
  p_tenant_id            uuid,
  p_actor_id             uuid,
  p_cancel               boolean,
  p_description          text,
  p_scheduled_start      timestamptz,
  p_scheduled_end        timestamptz,
  p_notes_for_technician text,
  p_technician_id        uuid,
  p_priority             text,
  p_service_location     text default null,
  p_skill_id             uuid default null,
  p_customer_id          uuid default null
)
returns setof public.jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job              jobs%rowtype;
  v_pending          boolean;
  v_changes          jsonb := '{}'::jsonb;
  v_start            timestamptz;
  v_end              timestamptz;
  v_template_id      uuid;
  v_template_version integer;
begin
  -- Tenant-scoped row lock. A missing or cross-tenant job returns no rows, which
  -- the app maps to 404.
  select * into v_job from jobs
   where id = p_job_id and tenant_id = p_tenant_id
   for update;
  if not found then
    return;
  end if;

  -- Only a scheduled or pending job is modifiable. Anything else is PT409.
  if v_job.status not in ('scheduled', 'pending_approval') then
    raise exception 'job % is not modifiable in status %', p_job_id, v_job.status
      using errcode = 'PT409', hint = 'JOB_NOT_MODIFIABLE';
  end if;
  v_pending := v_job.status = 'pending_approval';

  if p_cancel then
    update jobs
       set status = 'cancelled',
           decided_by = case when v_pending then p_actor_id else decided_by end,
           decided_at = case when v_pending then now() else decided_at end,
           updated_at = now()
     where id = p_job_id;
    insert into activity_logs (job_id, tenant_id, event_type, actor_id)
    values (p_job_id, p_tenant_id, 'job_cancelled', p_actor_id);
  else
    -- CAP-5, database side: an employee-created job takes owner edits only while
    -- it is pending approval, whatever else its status is. The memberships join
    -- counts a removed or disabled employee too (they are still the employee
    -- who created the job); a creator with no membership row here (a platform
    -- admin) or an old row with no creator at all is not an employee and keeps
    -- the existing owner flow.
    if v_job.created_by is not null and not v_pending and exists (
      select 1 from memberships m
       where m.user_id = v_job.created_by
         and m.tenant_id = p_tenant_id
         and m.role = 'employee'
    ) then
      raise exception 'job % is not modifiable in status %', p_job_id, v_job.status
        using errcode = 'PT409', hint = 'JOB_NOT_MODIFIABLE';
    end if;

    -- A pending job keeps its creator as assignee until it is approved.
    if v_pending and p_technician_id is not null
       and p_technician_id is distinct from v_job.technician_id then
      raise exception 'a pending job stays with its creator until it is approved'
        using errcode = 'PT422', hint = 'PENDING_ASSIGNEE_LOCKED';
    end if;

    -- A moved customer must belong to this company. A missing or cross-tenant
    -- customer id is a not-found, never a silent swap — the same answer the
    -- create flow gives for a bad customer.
    if p_customer_id is not null
       and p_customer_id is distinct from v_job.customer_id then
      if not exists (
        select 1 from customers c
         where c.id = p_customer_id and c.tenant_id = p_tenant_id
      ) then
        raise exception 'customer % does not belong to this company', p_customer_id
          using errcode = 'PT404', hint = 'RESOURCE_NOT_FOUND';
      end if;
    end if;

    -- A moved skill must have a workflow template — the same lookup creation
    -- validates and stamps with. The found template is kept for the update below
    -- so the job's stamped work stays in step with its new skill.
    if p_skill_id is not null and p_skill_id is distinct from v_job.skill_id then
      select t.id, t.version into v_template_id, v_template_version
        from workflow_templates t
       where t.skill_id = p_skill_id
       order by t.version desc
       limit 1;
      if v_template_id is null then
        raise exception 'no workflow template found for skill %', p_skill_id
          using errcode = 'PT400', hint = 'VALIDATION_ERROR';
      end if;
    end if;

    -- Reject an inverted window using the EFFECTIVE values (after the COALESCE
    -- patch), so a one-sided edit cannot push the stored window past the other bound.
    v_start := coalesce(p_scheduled_start, v_job.scheduled_start);
    v_end   := coalesce(p_scheduled_end, v_job.scheduled_end);
    if v_end is not null and v_end < v_start then
      raise exception 'scheduled_end before scheduled_start'
        using errcode = 'PT422';
    end if;

    -- Collect the real changes only. A patch that repeats the stored value is no change.
    if p_description is not null and p_description is distinct from v_job.description then
      v_changes := v_changes || jsonb_build_object('description',
        jsonb_build_object('before', v_job.description, 'after', p_description));
    end if;
    if p_scheduled_start is not null and p_scheduled_start is distinct from v_job.scheduled_start then
      v_changes := v_changes || jsonb_build_object('scheduledStart',
        jsonb_build_object('before', v_job.scheduled_start, 'after', p_scheduled_start));
    end if;
    if p_scheduled_end is not null and p_scheduled_end is distinct from v_job.scheduled_end then
      v_changes := v_changes || jsonb_build_object('scheduledEnd',
        jsonb_build_object('before', v_job.scheduled_end, 'after', p_scheduled_end));
    end if;
    if p_notes_for_technician is not null
       and p_notes_for_technician is distinct from v_job.notes_for_technician then
      v_changes := v_changes || jsonb_build_object('notesForTechnician',
        jsonb_build_object('before', v_job.notes_for_technician, 'after', p_notes_for_technician));
    end if;
    if p_priority is not null and p_priority is distinct from v_job.priority then
      v_changes := v_changes || jsonb_build_object('priority',
        jsonb_build_object('before', v_job.priority, 'after', p_priority));
    end if;
    if p_technician_id is not null and p_technician_id is distinct from v_job.technician_id then
      v_changes := v_changes || jsonb_build_object('technicianId',
        jsonb_build_object('before', v_job.technician_id, 'after', p_technician_id));
    end if;
    if p_service_location is not null
       and p_service_location is distinct from v_job.service_location then
      v_changes := v_changes || jsonb_build_object('serviceLocation',
        jsonb_build_object('before', v_job.service_location, 'after', p_service_location));
    end if;
    if p_skill_id is not null and p_skill_id is distinct from v_job.skill_id then
      v_changes := v_changes || jsonb_build_object('skillId',
        jsonb_build_object('before', v_job.skill_id, 'after', p_skill_id));
    end if;
    if p_customer_id is not null and p_customer_id is distinct from v_job.customer_id then
      v_changes := v_changes || jsonb_build_object('customerId',
        jsonb_build_object('before', v_job.customer_id, 'after', p_customer_id));
    end if;

    if v_changes <> '{}'::jsonb then
      -- COALESCE: a NULL param leaves the column unchanged (PATCH semantics).
      -- Clearing a nullable field back to NULL is intentionally out of scope.
      -- The template columns follow the skill change (v_template_id is set only
      -- when the skill moved), so the stamped work never lags the new skill.
      update jobs
         set description          = coalesce(p_description, description),
             scheduled_start      = coalesce(p_scheduled_start, scheduled_start),
             scheduled_end        = coalesce(p_scheduled_end, scheduled_end),
             notes_for_technician = coalesce(p_notes_for_technician, notes_for_technician),
             technician_id        = coalesce(p_technician_id, technician_id),
             priority             = coalesce(p_priority, priority),
             service_location     = coalesce(p_service_location, service_location),
             skill_id             = coalesce(p_skill_id, skill_id),
             customer_id          = coalesce(p_customer_id, customer_id),
             workflow_template_id = case when v_template_id is not null
                                          then v_template_id
                                          else workflow_template_id end,
             workflow_template_version = case when v_template_id is not null
                                               then v_template_version
                                               else workflow_template_version end,
             updated_at           = now()
       where id = p_job_id;

      insert into activity_logs (job_id, tenant_id, event_type, actor_id, metadata)
      values (p_job_id, p_tenant_id, 'job_edited', p_actor_id,
              jsonb_build_object('changes', v_changes));

      -- Reassignment keeps its own row, as before, so older timelines still read.
      if p_technician_id is not null and p_technician_id is distinct from v_job.technician_id then
        insert into activity_logs (job_id, tenant_id, event_type, actor_id, metadata)
        values (p_job_id, p_tenant_id, 'job_reassigned', p_actor_id,
                jsonb_build_object(
                  'previousTechnicianId', v_job.technician_id,
                  'newTechnicianId', p_technician_id));
      end if;
    end if;
  end if;

  return query select * from jobs j where j.id = p_job_id and j.tenant_id = p_tenant_id;
end $$;

revoke all on function public.update_job_with_log(
  uuid, uuid, uuid, boolean, text, timestamptz, timestamptz, text, uuid, text, text, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.update_job_with_log(
  uuid, uuid, uuid, boolean, text, timestamptz, timestamptz, text, uuid, text, text, uuid, uuid)
  to postgres, service_role;
