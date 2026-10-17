-- SPEC-edit-customer CAP-4: PATCH /customers/:id needs change tracking.
-- customers had no updated_at column. Add it (not null, defaulted so the
-- pre-existing rows backfill) and attach the repo's existing convention
-- (update_updated_at_column, defined in 20260621000011_delta_sync_index.sql)
-- as a before-update trigger — same pattern as
-- 20261004000002_app_config_updated_at_trigger.sql.
-- Applied via Supabase MCP (pre-launch, safe).
alter table customers add column updated_at timestamptz not null default now();

create trigger customers_updated_at before update on public.customers
for each row execute function public.update_updated_at_column();
