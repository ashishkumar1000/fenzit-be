-- BMAD review P2 fix: app_config.updated_at had only DEFAULT now(), so an
-- owner edit via SQL left it frozen at seed time and the payload's
-- configVersion change-detector never moved. Attach the repo's existing
-- convention (update_updated_at_column, 20260621000011) as a trigger.
-- Applied to prod 2026-10-04 via Supabase MCP.
create trigger app_config_updated_at before update on public.app_config
for each row execute function public.update_updated_at_column();
