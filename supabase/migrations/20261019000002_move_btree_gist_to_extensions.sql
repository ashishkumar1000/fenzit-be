-- Defect R-16 (weekly-off screen test run, 2026-10-18): the Supabase advisor
-- warns `extension_in_public` — btree_gist sits in the public schema, where
-- its helper functions and operator classes mix with our own objects.
--
-- Move it to the `extensions` schema Supabase already provides. This is safe
-- for the existing exclusion constraints (enrolments, office rules/assignments,
-- weekly-off defaults/overrides): they reference the operator classes by
-- internal id, not by schema name. The `extensions` schema is on the default
-- search path of the roles that create constraints, so later migrations that
-- add `exclude using gist (uuid with =, ...)` keep working unchanged.
--
-- Rollback: alter extension btree_gist set schema public;

create schema if not exists extensions;
alter extension btree_gist set schema extensions;
