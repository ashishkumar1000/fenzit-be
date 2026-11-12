-- Story 2 of spec-employee-created-jobs (CAP-2, CAP-3, CAP-4): employee-created jobs.
--
-- Plain-English contract:
--   jobs.created_by          the user who created the job. Owner-created jobs carry the
--                            owner's id from now on. Older rows stay NULL.
--   status 'pending_approval' an employee's job that the owner must approve first. It is
--                            not 'scheduled', so the existing active, upcoming, overdue and
--                            history scopes already leave it out. It is not assigned work.
--   create_job_with_log      the same creation as before, plus two optional inputs:
--                            p_created_by (default: the acting user) and p_pending_approval
--                            (default false). Old callers that pass 12 inputs still work.
--                            The job and its activity row are written in one step.

alter table public.jobs
  add column created_by uuid references public.users (id) on delete restrict;

alter table public.jobs drop constraint jobs_status_check;
alter table public.jobs
  add constraint jobs_status_check check (
    status = any (array['scheduled', 'in_progress', 'completed', 'cancelled', 'pending_approval']::text[])
  );

drop function public.create_job_with_log(uuid, uuid, uuid, text, uuid, timestamptz, timestamptz, text, text, text, uuid, integer);

create function public.create_job_with_log(
  p_tenant_id          uuid,
  p_customer_id        uuid,
  p_technician_id      uuid,
  p_service_location   text,
  p_skill_id           uuid,
  p_scheduled_start    timestamptz,
  p_scheduled_end      timestamptz,
  p_description        text,
  p_priority           text,
  p_notes_for_technician text,
  p_actor_id           uuid,
  p_year               integer,
  p_created_by         uuid default null,
  p_pending_approval   boolean default false
)
returns setof public.jobs
language plpgsql
security definer
set search_path = 'public'
as $$
DECLARE
  v_seq        INT;
  v_job_number TEXT;
  v_job_id     UUID := gen_random_uuid();
  v_template_id      UUID;
  v_template_version INT;
  v_status     TEXT;
BEGIN
  SELECT id, version
    INTO v_template_id, v_template_version
    FROM workflow_templates
   WHERE skill_id = p_skill_id
   ORDER BY version DESC
   LIMIT 1;

  IF v_template_id IS NULL THEN
    RAISE EXCEPTION 'No workflow template found for skill %', p_skill_id;
  END IF;

  v_seq := increment_job_counter(p_tenant_id, p_year);
  v_job_number := 'JB-' || p_year::text || '-' || lpad(v_seq::text, 4, '0');
  v_status := CASE WHEN COALESCE(p_pending_approval, false) THEN 'pending_approval' ELSE 'scheduled' END;

  INSERT INTO jobs (
    id, tenant_id, job_number, customer_id, technician_id,
    service_location, skill_id, workflow_template_id,
    workflow_template_version, scheduled_start, scheduled_end,
    status, current_step, priority,
    description, notes_for_technician, created_by
  ) VALUES (
    v_job_id, p_tenant_id, v_job_number, p_customer_id, p_technician_id,
    p_service_location, p_skill_id, v_template_id,
    v_template_version, p_scheduled_start, p_scheduled_end,
    v_status, NULL, COALESCE(p_priority, 'normal'),
    p_description, p_notes_for_technician, COALESCE(p_created_by, p_actor_id)
  );

  INSERT INTO activity_logs (job_id, tenant_id, event_type, actor_id)
  VALUES (v_job_id, p_tenant_id, CASE WHEN v_status = 'pending_approval'
                                      THEN 'job_submitted' ELSE 'job_created' END,
          p_actor_id);

  RETURN QUERY SELECT * FROM jobs WHERE id = v_job_id;
END $$;

revoke all on function public.create_job_with_log(uuid, uuid, uuid, text, uuid, timestamptz, timestamptz, text, text, text, uuid, integer, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.create_job_with_log(uuid, uuid, uuid, text, uuid, timestamptz, timestamptz, text, text, text, uuid, integer, uuid, boolean)
  to postgres, service_role;
