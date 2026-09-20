-- De-stored-procedure pass for the reports module (Epic 12, Story 12-2).
--
-- User decision (2026-09-20): prefer plain SQL from the app — keep stored
-- procedures to a minimum. Both report RPCs created in migrations 49/50 are
-- dropped; their guarantees are re-implemented without app-facing functions:
--
--   1. claim_report_request (queued→generating lease claim) → the worker
--      (story 12-3) claims with a single guarded UPDATE:
--        update report_requests
--        set status='generating', locked_until=..., attempt_count=<n+1>
--        where id=<id> and status='queued'
--      A single conditional UPDATE is atomic in Postgres — exactly one
--      concurrent caller gets a row back; the loser updates zero rows.
--
--   2. create_report_request (atomic in-flight cap) → a declarative trigger
--      on report_requests (below). The app inserts plainly; the cap holds
--      against ANY concurrent write path, no RPC plumbing.
--
-- PTxxx SQLSTATE convention retained: PT429 → 429 REPORT_IN_FLIGHT_LIMIT.

drop function if exists public.claim_report_request(uuid, integer);
drop function if exists public.create_report_request(uuid, uuid, text, jsonb, integer);

-- In-flight guard (NFR-3): at most 3 rows per tenant in queued|generating.
-- Fires on INSERT; the mutating paths that could move a row back into
-- in-flight status all keep the count unchanged (failed→queued never happens:
-- recovery re-queues only expired-generating rows, which were already
-- counted). The advisory xact lock keyed on the tenant serializes concurrent
-- inserts — under READ COMMITTED an uncommitted sibling insert is otherwise
-- invisible to the count check.
create or replace function public.report_requests_in_flight_guard()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  v_in_flight integer;
  v_max constant integer := 3;  -- NFR-3
begin
  perform pg_advisory_xact_lock(hashtextextended(new.tenant_id::text, 0));

  select count(*) into v_in_flight
  from report_requests
  where tenant_id = new.tenant_id
    and status in ('queued', 'generating');

  if v_in_flight >= v_max then
    raise exception 'tenant % already has % in-flight report requests',
      new.tenant_id, v_max
      using errcode = 'PT429';
  end if;

  return new;
end $function$;

create trigger report_requests_in_flight_guard
  before insert on public.report_requests
  for each row
  execute function public.report_requests_in_flight_guard();