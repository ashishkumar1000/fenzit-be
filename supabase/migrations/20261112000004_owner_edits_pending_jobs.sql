-- Story 4 of spec-employee-created-jobs (CAP-5 owner edits, CAP-7 audit trail).
--
-- Plain-English contract for update_job_with_log:
--   scheduled jobs  Owner edits fields as before. Cancel still works.
--   pending jobs    Owner edits description, times, notes and priority. Owner may
--                   also cancel the pending job (it ends as 'cancelled', and the
--                   owner is recorded as the decider, like a rejection).
--                   The assignee cannot change while pending: the job stays with
--                   its creator until it is approved, so the creator keeps access.
--   any other job   Refused with PT409 (JOB_NOT_MODIFIABLE). Rejected jobs stay
--                   read-only, so an owner can never revive one by editing it.
--   audit           Every save that changes something writes ONE 'job_edited' row
--                   in the same step. Its metadata lists each changed field as
--                   {before, after}. A save with no real change writes nothing and
--                   does not bump updated_at. A reassignment also writes the
--                   existing 'job_reassigned' row, so older timelines still read.
--
-- Signature is unchanged (10 params), so create or replace keeps existing grants.

create or replace function update_job_with_log(
  p_job_id               uuid,
  p_tenant_id            uuid,
  p_actor_id             uuid,
  p_cancel               boolean,
  p_description          text,
  p_scheduled_start      timestamptz,
  p_scheduled_end        timestamptz,
  p_notes_for_technician text,
  p_technician_id        uuid,
  p_priority             text
)
returns setof jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job     jobs%rowtype;
  v_pending boolean;
  v_changes jsonb := '{}'::jsonb;
  v_start   timestamptz;
  v_end     timestamptz;
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
    -- A pending job keeps its creator as assignee until it is approved.
    if v_pending and p_technician_id is not null
       and p_technician_id is distinct from v_job.technician_id then
      raise exception 'a pending job stays with its creator until it is approved'
        using errcode = 'PT422', hint = 'PENDING_ASSIGNEE_LOCKED';
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

    if v_changes <> '{}'::jsonb then
      -- COALESCE: a NULL param leaves the column unchanged (PATCH semantics).
      -- Clearing a nullable field back to NULL is intentionally out of scope.
      update jobs
         set description          = coalesce(p_description, description),
             scheduled_start      = coalesce(p_scheduled_start, scheduled_start),
             scheduled_end        = coalesce(p_scheduled_end, scheduled_end),
             notes_for_technician = coalesce(p_notes_for_technician, notes_for_technician),
             technician_id        = coalesce(p_technician_id, technician_id),
             priority             = coalesce(p_priority, priority),
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
