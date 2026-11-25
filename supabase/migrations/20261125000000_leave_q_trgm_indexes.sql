-- Round-4 leave review defer (2026-11-24): the owner list's q needle ran
-- ILIKE '%…%' over users.name / memberships.employee_code /
-- leave_requests.reason with no trgm support, and the derived-status count
-- subquery grouped every tenant's day rows before the tenant join (the
-- repository now scopes it in SQL). These indexes keep q index-backed as
-- leave volume grows. Plain create index — the repo convention (no
-- CONCURRENTLY); tables are small at the 150-user target and the statement
-- is transaction-safe. Migration-runner constraint: nothing in fenzit-be's
-- jest path executes migrations — this file is applied manually and
-- verified against the real DB (the 2026-11-21 deactivated-status
-- migration's precedent).
--
-- The extension lives in the `extensions` schema (Supabase's convention —
-- a public-schema extension trips the extension_in_public advisor, the
-- btree_gist move's precedent) and the trgm operator class is qualified to
-- match.
create extension if not exists pg_trgm with schema extensions;

create index if not exists users_name_trgm_idx
  on public.users using gin (name extensions.gin_trgm_ops);

create index if not exists memberships_employee_code_trgm_idx
  on public.memberships using gin (employee_code extensions.gin_trgm_ops);

create index if not exists leave_requests_reason_trgm_idx
  on public.leave_requests using gin (reason extensions.gin_trgm_ops);
