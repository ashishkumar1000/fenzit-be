-- Records which app or site asked for an account deletion: 'web' or 'app'.
-- Applied to the live project on 2026-11-03 through the Supabase MCP without a
-- repo file; this file records the same change so the repo matches live.
-- The backend writes it on each request (account-deletion.service.ts) and the
-- admin list shows it. No decision reads it. Existing rows take 'web'.

alter table public.account_deletion_requests
  add column source text not null default 'web'
  constraint account_deletion_requests_source_check check (source in ('web', 'app'));
