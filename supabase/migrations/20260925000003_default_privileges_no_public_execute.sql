-- Story 14-1 (Epic 14 security prerequisite, review patch):
-- Default privileges deny PUBLIC EXECUTE for future postgres-created
-- functions, plus explicit service_role EXECUTE grants on the 10 existing
-- RPCs and a belt-and-suspenders UPDATE revoke from PUBLIC on public.users.
--
-- ACCURATE mechanism (corrects the NOTE in 20260925000001, verified against
-- PostgreSQL 17 source and probed live on 2026-09-25):
--   1. Postgres grants EXECUTE to PUBLIC at function CREATION (the hard-wired
--      acldefault for functions). CREATE OR REPLACE PRESERVES the function's
--      existing ACL — revokes from a previous migration survive a
--      same-signature replace. A CHANGED SIGNATURE creates a NEW pg_proc
--      entry, which again receives the creation-time grants.
--   2. Supabase's SCHEMA-SCOPED default privileges (`alter default
--      privileges ... in schema public`) can only ADD grants on top of the
--      hard-wired defaults — `revoke execute ... from public` under
--      `in schema public` strips anon/authenticated from the stored default
--      ACL but CANNOT subtract the hard-wired PUBLIC EXECUTE (probed: a new
--      function still carried `=X` afterwards).
--   3. The GLOBAL form (no `in schema`) REPLACES the hard-wired defaults —
--      `alter default privileges for role postgres revoke execute on
--      functions from public` makes future postgres-created functions start
--      with no PUBLIC EXECUTE (probed live: new function ACL becomes
--      `{postgres=X, service_role=X}`).
--   Rule for dev agents: any new or changed-signature DB function must still
--   revoke public EXECUTE (and grant explicit service_role EXECUTE) in its
--   OWN migration — the default privileges above cover the common case, but
--   they are not a substitute for the per-function rule, and a signature
--   change mints a fresh pg_proc entry regardless.
--
-- Explicit per-function service_role grants below make the app's RPC path
-- independent of PUBLIC grants and of default-privilege history. Signatures
-- identical to migration 20260925000001 (live pg_proc, 2026-09-25).
--
-- Scope note: the GLOBAL default-privilege entry applies to postgres-created
-- functions in every schema, not just public. Platform-internal functions in
-- auth/storage/realtime are created by their own roles (supabase_admin,
-- supabase_auth_admin, ...) and are unaffected; the owner always retains
-- EXECUTE implicitly regardless of ACLs.

-- Global: replace the hard-wired PUBLIC EXECUTE default for future
-- postgres-created functions (any schema).
alter default privileges for role postgres
  revoke execute on functions from public;

-- Schema-scoped: also strip anon/authenticated from the public-schema
-- default ACL (Supabase's default privileges had granted them).
alter default privileges for role postgres in schema public
  revoke execute on functions from public;
alter default privileges for role postgres in schema public
  revoke execute on functions from anon;
alter default privileges for role postgres in schema public
  revoke execute on functions from authenticated;

-- 1/10 advance_workflow_step
grant execute on function public.advance_workflow_step(uuid, uuid, uuid, text, text, text, double precision, double precision, double precision, boolean, text, boolean) to service_role;

-- 2/10 confirm_attachment
grant execute on function public.confirm_attachment(uuid, uuid, uuid, integer, uuid) to service_role;

-- 3/10 create_job_with_log
grant execute on function public.create_job_with_log(uuid, uuid, uuid, text, uuid, timestamp with time zone, timestamp with time zone, text, text, text, uuid, integer) to service_role;

-- 4/10 increment_job_counter
grant execute on function public.increment_job_counter(uuid, integer) to service_role;

-- 5/10 notifications_broadcast_changes
grant execute on function public.notifications_broadcast_changes() to service_role;

-- 6/10 report_requests_in_flight_guard
grant execute on function public.report_requests_in_flight_guard() to service_role;

-- 7/10 setup_tenant_for_owner
grant execute on function public.setup_tenant_for_owner(uuid, text, text, text, text, text) to service_role;

-- 8/10 update_job_with_log
grant execute on function public.update_job_with_log(uuid, uuid, uuid, boolean, text, timestamp with time zone, timestamp with time zone, text, uuid, text) to service_role;

-- 9/10 update_updated_at_column
grant execute on function public.update_updated_at_column() to service_role;

-- 10/10 workflow_steps_valid
grant execute on function public.workflow_steps_valid(jsonb) to service_role;

-- Symmetric belt-and-suspenders next to the anon/authenticated UPDATE
-- revokes in 20260925000002: PUBLIC holds no UPDATE on users today
-- (verified via role_table_grants before applying) — this pins that state
-- against future blanket grants.
revoke update on public.users from public;
