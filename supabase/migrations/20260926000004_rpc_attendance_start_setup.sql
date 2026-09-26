-- Story 15-2 (Epic 15): attendance_start_setup — FR-1 wizard start.
-- Starting the wizard touches two row-sets (attendance_settings +
-- attendance_setup_progress), so AD-3 makes it exactly one RPC instead of
-- two plain writes. Idempotent by construction: on conflict do nothing for
-- both rows, so a restart mid-wizard never resets progress and a double-tap
-- cannot duplicate anything. No tenant lock: there is no state transition
-- to serialise — a concurrent complete_setup can only interleave between
-- the two inserts and the caller's read-back, and both outcomes are valid
-- states of the same idempotent call.

create or replace function public.attendance_start_setup(
  p_tenant_id uuid,
  p_actor_id uuid
)
returns void
language sql
volatile
security definer
set search_path = public
as $$
  insert into public.attendance_settings (tenant_id)
  values (p_tenant_id)
  on conflict (tenant_id) do nothing;

  insert into public.attendance_setup_progress (tenant_id, current_step)
  values (p_tenant_id, 'offices')
  on conflict (tenant_id) do nothing;
$$;

revoke execute on function public.attendance_start_setup(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.attendance_start_setup(uuid, uuid) to service_role;