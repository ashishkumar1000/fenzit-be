-- Story 14-1 (Epic 14 security prerequisite, deferred-work item 1):
-- Revoke public EXECUTE on every public-schema DB function.
--
-- Postgres grants EXECUTE to PUBLIC by default, so before this migration every
-- job/workflow/notification RPC was callable directly with the app's
-- publishable key — skipping NestJS and its request validation — even though
-- the RPCs trust caller-supplied tenant/actor IDs.
--
-- Every app RPC call site routes through createAdmin() (service-role key:
-- jobs.service, workflow.service, attachments.service, webhooks.service,
-- auth.service), so revoking anon/authenticated/PUBLIC breaks nothing; the
-- explicit service_role grant and the owner (postgres) privilege stay intact.
-- Same pattern as migration 20260920000005 (claim_report_request).
--
-- Signatures below match the live pg_proc catalog exactly (verified via
-- Supabase MCP on 2026-09-25) — one signature per function; the historical
-- overloads were already dropped by 20260913000005 / 20260920000007.
--
-- NOTE for future RPCs (mechanism corrected 2026-09-25 by 20260925000003 —
-- that header is authoritative): the hard-wired PUBLIC EXECUTE is granted at
-- function CREATION. `create or replace function` PRESERVES the existing
-- ACLs; a CHANGED SIGNATURE mints a NEW pg_proc entry that starts with the
-- default grants again. Every new or changed-signature function must repeat
-- these revokes and grant explicit service_role EXECUTE in its own migration
-- (20260925000003 now denies PUBLIC by default for postgres-created
-- functions; project-context.md rule 5 is the operative rule).

-- 1/10 advance_workflow_step (Story 3.7 + 7-3 signature)
revoke execute on function public.advance_workflow_step(uuid, uuid, uuid, text, text, text, double precision, double precision, double precision, boolean, text, boolean) from public;
revoke execute on function public.advance_workflow_step(uuid, uuid, uuid, text, text, text, double precision, double precision, double precision, boolean, text, boolean) from anon;
revoke execute on function public.advance_workflow_step(uuid, uuid, uuid, text, text, text, double precision, double precision, double precision, boolean, text, boolean) from authenticated;

-- 2/10 confirm_attachment
revoke execute on function public.confirm_attachment(uuid, uuid, uuid, integer, uuid) from public;
revoke execute on function public.confirm_attachment(uuid, uuid, uuid, integer, uuid) from anon;
revoke execute on function public.confirm_attachment(uuid, uuid, uuid, integer, uuid) from authenticated;

-- 3/10 create_job_with_log
revoke execute on function public.create_job_with_log(uuid, uuid, uuid, text, uuid, timestamp with time zone, timestamp with time zone, text, text, text, uuid, integer) from public;
revoke execute on function public.create_job_with_log(uuid, uuid, uuid, text, uuid, timestamp with time zone, timestamp with time zone, text, text, text, uuid, integer) from anon;
revoke execute on function public.create_job_with_log(uuid, uuid, uuid, text, uuid, timestamp with time zone, timestamp with time zone, text, text, text, uuid, integer) from authenticated;

-- 4/10 increment_job_counter
revoke execute on function public.increment_job_counter(uuid, integer) from public;
revoke execute on function public.increment_job_counter(uuid, integer) from anon;
revoke execute on function public.increment_job_counter(uuid, integer) from authenticated;

-- 5/10 notifications_broadcast_changes
revoke execute on function public.notifications_broadcast_changes() from public;
revoke execute on function public.notifications_broadcast_changes() from anon;
revoke execute on function public.notifications_broadcast_changes() from authenticated;

-- 6/10 report_requests_in_flight_guard
revoke execute on function public.report_requests_in_flight_guard() from public;
revoke execute on function public.report_requests_in_flight_guard() from anon;
revoke execute on function public.report_requests_in_flight_guard() from authenticated;

-- 7/10 setup_tenant_for_owner
revoke execute on function public.setup_tenant_for_owner(uuid, text, text, text, text, text) from public;
revoke execute on function public.setup_tenant_for_owner(uuid, text, text, text, text, text) from anon;
revoke execute on function public.setup_tenant_for_owner(uuid, text, text, text, text, text) from authenticated;

-- 8/10 update_job_with_log
revoke execute on function public.update_job_with_log(uuid, uuid, uuid, boolean, text, timestamp with time zone, timestamp with time zone, text, uuid, text) from public;
revoke execute on function public.update_job_with_log(uuid, uuid, uuid, boolean, text, timestamp with time zone, timestamp with time zone, text, uuid, text) from anon;
revoke execute on function public.update_job_with_log(uuid, uuid, uuid, boolean, text, timestamp with time zone, timestamp with time zone, text, uuid, text) from authenticated;

-- 9/10 update_updated_at_column (BEFORE-row trigger function; trigger calls
-- are privilege-exempt, so revoking EXECUTE does not affect it)
revoke execute on function public.update_updated_at_column() from public;
revoke execute on function public.update_updated_at_column() from anon;
revoke execute on function public.update_updated_at_column() from authenticated;

-- 10/10 workflow_steps_valid (CHECK-constraint evaluator; CHECK eval runs as
-- the function owner, so revoking EXECUTE does not affect it)
revoke execute on function public.workflow_steps_valid(jsonb) from public;
revoke execute on function public.workflow_steps_valid(jsonb) from anon;
revoke execute on function public.workflow_steps_valid(jsonb) from authenticated;
