-- Server-driven app configuration (SPEC-server-driven-config): a GLOBAL
-- key/value store the mobile app overlays on its shipped defaults. RLS is
-- enabled with NO policies: only the service role (fenzit-be admin client)
-- reads/writes; anon and authenticated roles get nothing.
-- Applied to prod 2026-10-03 via Supabase MCP.
create table if not exists public.app_config (
  key text primary key,
  value jsonb not null,
  description text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.app_config enable row level security;

-- v1 key set (defaults equal today's shipped behavior — kill-switch rule).
insert into public.app_config (key, value, description) values
  ('min_supported_version', '"1.0.0"'::jsonb, 'Minimum app version allowed against this API; lower installs see the forced-update screen'),
  ('force_update_message', '"Please update the Fenzit app to continue."'::jsonb, 'Copy shown on the forced-update screen'),
  ('api_timeout_ms', '30000'::jsonb, 'Request timeout (ms) the app applies to API calls; client clamps to 5000-120000'),
  ('maintenance_banner', '""'::jsonb, 'Non-empty = banner text shown in the app; empty = hidden')
on conflict (key) do nothing;

-- BE cache invalidation: the backend keeps app_config in memory (TTL as the
-- safety net) and subscribes to Postgres changes so an edit invalidates the
-- cache immediately instead of waiting out the TTL.
alter publication supabase_realtime add table public.app_config;
