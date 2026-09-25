-- Story 14-1 (Epic 14 security prerequisite, deferred-work item 2):
-- Column-limit the self-service update path on public.users to `name`.
--
-- Before this migration anon/authenticated held full table UPDATE grants while
-- `users_update_own` was a row-only RLS policy — so a token holder could update
-- ANY column of their own row, including `role` and `tenant_id` (the next
-- login would mint an owner / cross-tenant JWT).
--
-- Mechanism (grant-level, per the spec's approach): a row-only RLS policy
-- cannot reject a combined `SET name = 'x', role = 'owner'` update — but the
-- column privilege check does. Postgres evaluates column privileges before RLS,
-- so an update touching any column outside the grant is denied (42501) even
-- when it matches zero rows.
--
-- DEVIATION NOTE (spec asked for a column-limited `FOR UPDATE (name)` policy):
-- PostgreSQL 17 does not support column lists on CREATE POLICY — the syntax
-- was probed live on 2026-09-25 and rejected (42601 at `for update (`). The
-- column limitation is therefore carried entirely by the grants below, which
-- the spec itself identified as the operative check. The policy is dropped and
-- recreated with its IDENTICAL row-level definition purely to document the
-- final state in one place; its semantics are unchanged.
--
-- Preserved untouched: users_read_own_or_null_tenant, users_insert_only_
-- service_role, and all SELECT/INSERT/DELETE/TRUNCATE grants. anon loses
-- UPDATE entirely; authenticated gains column-level UPDATE on (name) only.
-- service_role keeps its full table UPDATE grant (every app write to users
-- routes through createAdmin()).

drop policy users_update_own on public.users;

create policy users_update_own on public.users
  for update
  using (auth.jwt() ->> 'sub' = id::text)
  with check (auth.jwt() ->> 'sub' = id::text);

-- anon: no UPDATE at all.
revoke update on public.users from anon;

-- authenticated: whole-table UPDATE gone, replaced by the (name) column grant.
revoke update on public.users from authenticated;
grant update (name) on public.users to authenticated;
