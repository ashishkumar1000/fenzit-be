-- Roles and access, step 1a: the new structure (additive only).
--
-- Plain-English contract
--   * Four roles: platform_admin (a flag on the user), and company_admin /
--     employee / viewer (a role on a membership). Spec: artifacts/
--     implementation-artifacts/roles-and-access-spec.md.
--   * `memberships` links one user to one company with one role and a status
--     (invited, active, removed). It also holds the employee code. Rows are
--     never deleted: a removed member keeps a row with status 'removed', so
--     attendance, leave and audit records keep pointing at a real row.
--   * `audit_log` records who changed what, in which company, and when. It
--     is append-only: nobody can edit or delete a row.
--   * Two helpers, `private.current_company_id()` and
--     `private.current_member_role()`, tell a row-level security policy which
--     company and role the signed-in person has RIGHT NOW (read from
--     memberships, not from the token).
--
-- Nothing existing is removed or changed in a way the current backend would
-- notice. The old users.role / tenant_id / status columns stay until step 4.
-- The one relaxation: users.role may now be empty, so a new identity-only user
-- (created by an invite) does not need an old-style role.
--
-- Pre-launch: no data needs converting.

-- 1. users: three new columns --------------------------------------------------

-- platform_admin: fenzit staff. Never settable by a client (no column grant).
alter table public.users
  add column platform_admin boolean not null default false;

-- disabled: a disabled person is refused at login and on every request.
alter table public.users
  add column disabled boolean not null default false;

-- email: an extra way to log in (web login spec). Lowercase, one per user.
alter table public.users
  add column email text;

alter table public.users
  add constraint users_email_key unique (email);

alter table public.users
  add constraint users_email_format check (
    email is null
    or (
      email = lower(email)
      and length(email) between 3 and 254
      and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
    )
  );

-- The old role column stays (steps 2-3 still read it) but a new identity-only
-- user has no old-style role. The existing check still allows NULL.
alter table public.users
  alter column role drop not null;

-- 2. memberships ---------------------------------------------------------------

create table public.memberships (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.users (id) on delete restrict,
  tenant_id     uuid not null references public.tenants (id) on delete restrict,
  role          text not null
                  constraint memberships_role_check
                  check (role in ('company_admin', 'employee', 'viewer')),
  status        text not null default 'invited'
                  constraint memberships_status_check
                  check (status in ('invited', 'active', 'removed')),
  -- EMP-001 style code, unique inside the company. Kept for life, even when
  -- the member is removed and later re-invited.
  employee_code text not null,
  invited_by    uuid references public.users (id) on delete restrict,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- One row per person per company. The 15 attendance and leave foreign keys
  -- point at (user_id, tenant_id) in step 3.
  constraint memberships_user_tenant_key unique (user_id, tenant_id),
  constraint memberships_tenant_employee_code_key unique (tenant_id, employee_code)
);

-- One live (invited or active) membership per person at launch. Removed rows
-- are history and are ignored. Drop this index to allow several companies.
create unique index memberships_one_live_per_user
  on public.memberships (user_id)
  where status <> 'removed';

-- "Who are the active admins of this company?" (alert recipients, last-admin check)
create index memberships_tenant_role_active_idx
  on public.memberships (tenant_id, role)
  where status = 'active';

-- Foreign-key helper indexes (invited_by).
create index memberships_invited_by_idx
  on public.memberships (invited_by)
  where invited_by is not null;

create trigger memberships_updated_at
  before update on public.memberships
  for each row execute function public.update_updated_at_column();

-- Backend only. RLS on with no policy = nobody on the public API can read it.
alter table public.memberships enable row level security;
revoke all on table public.memberships from anon, authenticated;

-- 3. audit_log -----------------------------------------------------------------

create table public.audit_log (
  id                      uuid primary key default gen_random_uuid(),
  created_at              timestamptz not null default now(),
  actor_user_id           uuid not null references public.users (id) on delete restrict,
  -- Was the actor acting as fenzit staff? Recorded at the time, so it stays
  -- true to history even if the flag changes later.
  actor_is_platform_admin boolean not null,
  -- The company the change belongs to. NULL only for platform-wide actions
  -- such as disabling a user.
  tenant_id               uuid references public.tenants (id) on delete restrict,
  action                  text not null
                            constraint audit_log_action_check
                            check (length(btrim(action)) between 1 and 80),
  target_user_id          uuid references public.users (id) on delete restrict,
  details                 jsonb not null default '{}'::jsonb
);

create index audit_log_tenant_created_idx
  on public.audit_log (tenant_id, created_at desc);
create index audit_log_actor_idx
  on public.audit_log (actor_user_id);
create index audit_log_target_idx
  on public.audit_log (target_user_id)
  where target_user_id is not null;

-- Append-only guard. Plain English: any attempt to change or remove an audit
-- row, or to empty the table, stops with an error. Only the database owner can
-- drop the trigger, and that would itself be a deliberate schema change.
create function public.audit_log_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit_log is append-only'
    using errcode = 'PT403', hint = 'FORBIDDEN';
end;
$$;

create trigger audit_log_no_change
  before update or delete on public.audit_log
  for each row execute function public.audit_log_append_only();

create trigger audit_log_no_truncate
  before truncate on public.audit_log
  for each statement execute function public.audit_log_append_only();

alter table public.audit_log enable row level security;
revoke all on table public.audit_log from anon, authenticated;
revoke update, delete, truncate on table public.audit_log from service_role;
-- A company admin may read their own company's rows through the API. Platform
-- admins read all rows through the backend.
grant select on table public.audit_log to authenticated;

-- 4. Helpers for row-level security -------------------------------------------

-- Kept in a private schema so the public API cannot call them as functions.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated, service_role;

-- The signed-in person's company, or NULL. Counts only an ACTIVE membership of
-- a person who is not disabled. Reads `sub` from the token (identity only).
create function private.current_company_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.tenant_id
    from public.memberships m
    join public.users u on u.id = m.user_id
   where m.user_id = nullif(auth.jwt() ->> 'sub', '')::uuid
     and m.status = 'active'
     and not u.disabled
   limit 1
$$;

-- The signed-in person's role in that company, or NULL. Same rules.
create function private.current_member_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select m.role
    from public.memberships m
    join public.users u on u.id = m.user_id
   where m.user_id = nullif(auth.jwt() ->> 'sub', '')::uuid
     and m.status = 'active'
     and not u.disabled
   limit 1
$$;

revoke all on function private.current_company_id() from public, anon, authenticated;
revoke all on function private.current_member_role() from public, anon, authenticated;
grant execute on function private.current_company_id() to authenticated, service_role;
grant execute on function private.current_member_role() to authenticated, service_role;

-- The audit log's own read policy uses the helpers, so it is created here.
create policy audit_log_company_admin_read on public.audit_log
  for select to authenticated
  using (
    tenant_id = (select private.current_company_id())
    and (select private.current_member_role()) = 'company_admin'
  );

-- The append-only trigger function is internal.
revoke all on function public.audit_log_append_only() from public, anon, authenticated;
