-- Review round 3 fixes.

-- 1. Staff (platform admins) have no membership, so they can never be the
--    "who did it" on leave, correction and day-override rows when the key
--    demands a membership. Point those four "who did it" columns at the
--    person (users.id) instead. The employee columns still point at
--    memberships, so an employee must belong to the company.
alter table public.leave_requests
  drop constraint leave_requests_created_by_tenant_fkey,
  add constraint leave_requests_created_by_fkey
    foreign key (created_by) references public.users(id) on delete restrict;
alter table public.leave_events
  drop constraint leave_events_actor_tenant_fkey,
  add constraint leave_events_actor_id_fkey
    foreign key (actor_id) references public.users(id) on delete restrict;
alter table public.attendance_day_overrides
  drop constraint attendance_day_overrides_created_by_tenant_fkey,
  add constraint attendance_day_overrides_created_by_fkey
    foreign key (created_by) references public.users(id) on delete restrict;
alter table public.attendance_corrections
  drop constraint attendance_corrections_actor_tenant_fkey,
  add constraint attendance_corrections_actor_id_fkey
    foreign key (actor_id) references public.users(id) on delete restrict;

-- 2. setup_tenant_for_owner, repeat call: a field left out of the request keeps
--    its saved value instead of being wiped. Company name and state are
--    required, so they always replace.
do $outer$
declare
  v_def text;
  v_new text;
begin
  v_def := pg_get_functiondef('public.setup_tenant_for_owner(uuid, text, text, text, text, text)'::regprocedure);
  v_new := replace(v_def,
$a$           gstin        = p_gstin,
           address      = p_address,
           state_code   = p_state_code,
           upi_vpa      = p_upi_vpa,
           updated_at   = now()$a$,
$b$           gstin        = coalesce(p_gstin, t.gstin),
           address      = coalesce(p_address, t.address),
           state_code   = p_state_code,
           upi_vpa      = coalesce(p_upi_vpa, t.upi_vpa),
           updated_at   = now()$b$);
  if v_new = v_def then
    raise exception 'setup_tenant_for_owner: expected text not found, nothing patched';
  end if;
  execute v_new;
end $outer$;
