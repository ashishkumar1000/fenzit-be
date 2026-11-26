-- Story 24-1 of spec-company-hierarchy (CAP-1): the reporting tree's edge.
--
-- Plain-English contract:
--   Each membership may name the member it reports to ("Reports to"),
--   in the same company. NULL means "no reporting manager" — today's
--   behaviour, where the company admins are the fallback approvers.
--   The database enforces only what DDL can: the manager's membership row
--   exists in the SAME company (composite FK) and nobody reports to
--   themselves (CHECK). Everything else — manager is active and enabled,
--   target is not an admin, no cycles, depth cap — lives in the NestJS
--   transaction under the tenant lock, because this epic is RPC-free.
--
-- No function, no grant, no policy: memberships stays service-only under
-- deny-by-default RLS, and the backend writes through the direct pg pool.

alter table public.memberships
  add column manager_id uuid;

-- Composite FK, not a plain users(id) reference: (manager_id, tenant_id)
-- must match a membership of the SAME company, so a cross-company manager
-- id can never be stored. memberships_user_tenant_key (user_id, tenant_id)
-- is the unique target. Rows are never deleted (removal flips status), so
-- RESTRICT is the honest rule.
alter table public.memberships
  add constraint memberships_manager_fk
  foreign key (manager_id, tenant_id)
  references public.memberships (user_id, tenant_id)
  on delete restrict
  on update restrict;

-- "You cannot report to yourself."
alter table public.memberships
  add constraint memberships_manager_not_self
  check (manager_id is null or manager_id <> user_id);

-- "Who reports to this person?" — the re-parent and subtree walks.
create index memberships_tenant_manager_idx
  on public.memberships (tenant_id, manager_id)
  where manager_id is not null;
