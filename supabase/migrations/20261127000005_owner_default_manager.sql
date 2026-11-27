-- Story 24-8 (2026-11-27): no member is left without a reporting manager.
--
-- The owner chose the rule: whenever a non-admin member has no manager — an
-- invite that never named one, a clear, a manager who resigned before this
-- migration — they report to the company owner. The default is the tenant
-- owner while that membership still serves, otherwise the earliest active
-- admin (an owner can be deactivated or removed once another admin exists).
--
-- This migration is the one-time backfill for rows that predate the rule. The
-- write paths (invite, setManager clear, deactivate, remove) answer the same
-- question in TypeScript: src/common/members/default-manager.ts.
--
-- Untouched:
--   * company admins — they sit at the top and must never hold a pointer;
--   * removed members — history, hidden from every read;
--   * a company with no active admin — impossible while the last-admin rule
--     holds, and leaving the row alone is the honest answer if it ever is not.

with active_admins as (
  select m.tenant_id,
         m.user_id,
         row_number() over (
           partition by m.tenant_id
           order by (m.user_id = t.created_by) desc, m.created_at, m.user_id
         ) as priority
    from public.memberships m
    join public.users u on u.id = m.user_id
    join public.tenants t on t.id = m.tenant_id
   where m.role = 'company_admin'
     and m.status = 'active'
     and not u.disabled
),
default_manager as (
  select tenant_id, user_id
    from active_admins
   where priority = 1
)
update public.memberships m
   set manager_id = d.user_id,
       updated_at = now()
  from default_manager d
 where m.tenant_id = d.tenant_id
   and m.manager_id is null
   and m.role <> 'company_admin'
   and m.status in ('invited', 'active', 'deactivated')
   and m.user_id <> d.user_id;

-- A pointer must always name an active manager; the pre-existing FK only
-- proves the person is a member of the company.
comment on column public.memberships.manager_id is
  'Who this member reports to. Non-admin members always carry one: the company owner (or the earliest active admin) is the default — story 24-8.';
