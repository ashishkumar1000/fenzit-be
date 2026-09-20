-- Story 12-7: owner retry of a failed report request.
--
-- A failed request was terminal — the owner's only recourse was to queue a
-- NEW request for the same range, which litters history with duplicate rows.
-- Retry instead re-queues the SAME row (POST /reports/:id/retry → a plain
-- guarded UPDATE from the app, no stored procedure): status back to 'queued',
-- the error stamp cleared, attempt_count reset (a deliberate human retry is a
-- fresh run of up to the worker's own attempt budget).
--
-- The in-flight cap trigger (migration 53) was INSERT-only because back then
-- "failed→queued never happens". Retry makes it happen, so the trigger is
-- widened to `insert or update of status` — still fully declarative, no RPC.
-- The check now runs only when a row ENTERS the in-flight set from outside
-- it; transitions inside the set or out of it are count-neutral:
--   · INSERT                                → checked (as before)
--   · queued→generating   (worker claim)    → row already counted → skipped
--   · generating→queued   (lease recovery)  → row already counted → skipped
--   · generating→ready/failed (terminal)    → count only ever falls → skipped
--   · ready/failed→queued (owner retry)     → enters the set → checked

create or replace function public.report_requests_in_flight_guard()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  v_in_flight integer;
  v_max constant integer := 3;  -- NFR-3
begin
  -- Count-neutral transitions skip the check entirely: the worker's
  -- queued→generating claim and lease recovery keep the row inside the
  -- in-flight set (already counted), and a terminal stamp only frees a
  -- slot. Re-checking those would falsely 429 the finishing stamp of the
  -- third in-flight row.
  if tg_op = 'UPDATE'
     and (
       new.status not in ('queued', 'generating')
       or old.status in ('queued', 'generating')
     )
  then
    return new;
  end if;

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

drop trigger if exists report_requests_in_flight_guard on public.report_requests;
create trigger report_requests_in_flight_guard
  before insert or update of status
  on public.report_requests
  for each row
  execute function public.report_requests_in_flight_guard();