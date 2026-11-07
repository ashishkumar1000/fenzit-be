-- Bulk customer import, follow-up to 20261107000014 (review patch).
--
-- Plain-English contract:
--   * The backend updates an import run's counts while the run is going, so
--     service_role must be able to UPDATE import_batches. The earlier migration
--     granted only SELECT and INSERT, while its own comment said service_role
--     gets exactly the privileges the backend uses. This makes the grant match.
--   * The backend never deletes or truncates a batch. Those privileges are
--     removed from service_role (Supabase's default privileges had added them).
--   * Still no policies for anon or authenticated: they get nothing.

GRANT SELECT, INSERT, UPDATE ON public.import_batches TO service_role;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.import_batches FROM service_role;
