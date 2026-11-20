-- The jobs list's flattened read model, for the web console's paged jobs
-- table (GET /jobs/page). The console needs to search jobs by their people —
-- customer, employee, skill — and sort them by those names, which PostgREST
-- can only do against bare columns. Flattening the joins into a view makes
-- every filter a plain column predicate, the same shape the customers
-- console table reads (20261117130000 customers_overview).

-- Drop-then-create, not create-or-replace: column additions mid-list are not
-- allowed on an existing view, and revisions will keep widening this one.
drop view if exists public.jobs_overview;

create view public.jobs_overview
with (security_invoker = true) as
select
  j.id,
  j.job_number,
  j.tenant_id,
  j.customer_id,
  j.technician_id,
  j.service_location,
  j.scheduled_start,
  j.scheduled_end,
  j.status,
  j.priority,
  j.description,
  j.completed_at,
  j.current_step,
  j.skill_id,
  j.created_at,
  j.updated_at,
  -- Epic 22 decision fields: the console's status cell shows the rejection
  -- reason under a rejected job, exactly like the legacy list did.
  j.decided_at,
  j.rejection_reason,
  c.name  as customer_name,
  u.name  as technician_name,
  s.name  as skill_name,
  wt.version as template_version,
  wt.steps   as template_steps
from public.jobs j
left join public.customers c on c.id = j.customer_id
left join public.users u     on u.id = j.technician_id
left join public.skills s    on s.id = j.skill_id
left join public.workflow_templates wt
  on wt.skill_id = j.skill_id and wt.version = j.workflow_template_version;

-- Grants hygiene, re-asserted on every revision (20261001000001 precedent:
-- the view must stay invisible to PostgREST; only the backend's service_role
-- reads it). Create or replace does not re-grant, so this block rides every
-- future revision.
revoke all on public.jobs_overview
  from anon, authenticated, service_role;
grant select on public.jobs_overview to service_role;
