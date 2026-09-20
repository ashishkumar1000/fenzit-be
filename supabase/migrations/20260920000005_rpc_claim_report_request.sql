-- Claim RPC for the report generation worker (Epic 12, Story 12-1).
-- Performs the queued → generating transition atomically under a row lock, so
-- a crashed/restarted worker can never double-run a request.
--
-- Caller discipline: the worker runs with the service-role key. EXECUTE is
-- revoked from anon/authenticated below (functions grant it to public by
-- default). The RPC takes ONLY the request id — the row's own tenant_id
-- governs; there is no client-supplied tenant parameter to spoof.
--
-- PTxxx SQLSTATE convention (see advance_workflow_step): last 3 digits = the
-- HTTP status the app maps the failure to.
create or replace function public.claim_report_request(
  p_request_id    uuid,
  p_lease_seconds integer default 120
)
returns setof public.report_requests
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_request public.report_requests%rowtype;
begin
  -- Row lock: concurrent claims for the same id serialize here; the loser
  -- sees the winner's status and takes the PT409 branch.
  select * into v_request
  from report_requests
  where id = p_request_id
  for update;

  -- Unknown id → empty set, which the app maps to 404 (cross-tenant is
  -- indistinguishable from not-found, matching advance_workflow_step).
  if not found then
    return;
  end if;

  -- Only a queued row is claimable. A row already generating (in-flight lease
  -- still valid) or terminal must not re-run. Lease recovery re-queues
  -- expired-generating rows in the worker before calling this RPC.
  if v_request.status <> 'queued' then
    raise exception 'report request % not claimable in status %', p_request_id, v_request.status
      using errcode = 'PT409';
  end if;

  update report_requests
  set status        = 'generating',
      locked_until  = now() + make_interval(secs => p_lease_seconds),
      attempt_count = attempt_count + 1
  where id = p_request_id;

  return query select * from report_requests where id = p_request_id;
end $function$;

-- Service-role-only call path (stricter than the older RPCs, which still grant
-- anon/authenticated EXECUTE). EXECUTE is granted to PUBLIC by default, so the
-- revokes cover PUBLIC explicitly — service_role keeps its own grant.
revoke execute on function public.claim_report_request(uuid, integer) from public;
revoke execute on function public.claim_report_request(uuid, integer) from anon;
revoke execute on function public.claim_report_request(uuid, integer) from authenticated;