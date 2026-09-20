-- Atomic report-request create for the reports module (Epic 12, Story 12-2).
--
-- The in-flight cap (max 3 queued+generating per tenant, NFR-3) must be
-- enforced ATOMICALLY: a plain count-then-insert read across two calls lets N
-- concurrent submissions all pass the same count check and blow past the cap.
-- Supabase's JS client cannot open a multi-statement transaction, so — per the
-- repo's established pattern (increment_job_counter) — the count+insert lives
-- in one RPC.
--
-- Serialization: a transaction-scoped advisory lock keyed on the tenant id.
-- Concurrent creates for the same tenant queue up here; each sees the
-- committed count of the previous one. Tenants never contend with each other.
--
-- Caller discipline: service-role only (worker/API service layer). EXECUTE is
-- revoked from public/anon/authenticated — same posture as
-- claim_report_request (migration 49).
--
-- PTxxx SQLSTATE convention: PT429 → the app maps to report_in_flight_limit.
create or replace function public.create_report_request(
  p_tenant_id      uuid,
  p_requested_by   uuid,
  p_report_type    text,
  p_params         jsonb,
  p_max_in_flight  integer default 3
)
returns setof public.report_requests
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_in_flight integer;
begin
  -- Serialize concurrent creates for this tenant (see header).
  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text, 0));

  select count(*) into v_in_flight
  from report_requests
  where tenant_id = p_tenant_id
    and status in ('queued', 'generating');

  if v_in_flight >= p_max_in_flight then
    raise exception 'tenant % has % in-flight report requests (max %)',
      p_tenant_id, v_in_flight, p_max_in_flight
      using errcode = 'PT429';
  end if;

  return query
    insert into report_requests (tenant_id, requested_by, report_type, params)
    values (p_tenant_id, p_requested_by, p_report_type, p_params)
    returning *;
end $function$;

revoke execute on function public.create_report_request(uuid, uuid, text, jsonb, integer) from public;
revoke execute on function public.create_report_request(uuid, uuid, text, jsonb, integer) from anon;
revoke execute on function public.create_report_request(uuid, uuid, text, jsonb, integer) from authenticated;