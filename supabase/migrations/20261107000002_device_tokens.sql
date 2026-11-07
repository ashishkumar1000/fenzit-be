-- Firebase push, Phase 3 (SPEC-firebase-integration / CAP-1): the
-- device_tokens store behind POST /device-tokens and DELETE /device-tokens/:token.
--
-- Plain-English contract: an FCM registration token belongs to the user whose
-- JWT registered it LAST (the token PK upserts, so a shared phone rebinds the
-- token to whoever signs in next — the previous user's pushes stop reaching
-- it). One row per device token; the backend's push sweep reads only rows of
-- the notification's own recipient, and only while that user is a non-disabled
-- active member of that notification's tenant (the join lives in
-- src/push/push-sweep.service.ts, never here).
--
-- last_seen_at is refreshed on every register call; the pg_cron job below
-- prunes tokens silent for 90 days (Android expires registrations at 270 days
-- — stale registrations are undeliverable long before, and the sweep also
-- deletes dead tokens on their next send failure). last_failure carries the
-- most recent FCM error code for that token (diagnostics only, never blocks
-- the row).
--
-- RLS is on with NO policies, and anon and authenticated have no grants, so
-- only the backend's service role reads or writes this table — the token is a
-- server-side credential and must never be readable through the public API.
-- (Template: 20261103000000_account_deletion_requests.sql.)

create table public.device_tokens (
  token        text primary key,   -- upsert target (idempotent: StrictMode re-posts are a no-op)
  user_id      uuid not null references public.users (id) on delete cascade,
  platform     text not null,
  app_version  text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_failure text,
  constraint device_tokens_platform_check check (
    platform in ('android', 'ios')
  )
);

comment on table public.device_tokens is
  'FCM registration tokens per signed-in user (server credential). RLS on, no policies: service role only.';

-- The sweep's per-batch token lookup joins on user_id.
create index device_tokens_user_idx
  on public.device_tokens (user_id);

alter table public.device_tokens enable row level security;

revoke all on public.device_tokens from anon, authenticated;

-- The push sweep's only notifications read: unsent rows, oldest first.
-- Partial on pushed_at IS NULL so the index stays tiny (claimed rows leave it
-- immediately) and the 30-day cleanup never has to scan it.
create index idx_notifications_pending_push
  on public.notifications (created_at)
  where pushed_at is null;

-- Nightly prune of stale tokens (90 days silent). Mirrors the pg_cron
-- convention of 20260909000004_notifications_cleanup.sql: extension guard +
-- usage grant + idempotent re-run (unschedule-then-schedule). 03:40 UTC keeps
-- clear of the hourly jobs at :00 and :10.
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

GRANT USAGE ON SCHEMA cron TO postgres;

SELECT cron.unschedule('device-tokens-prune') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'device-tokens-prune'
);
SELECT cron.schedule(
  'device-tokens-prune',         -- unique job name
  '40 3 * * *',                  -- daily at 03:40 UTC
  $$DELETE FROM public.device_tokens WHERE last_seen_at < now() - interval '90 days'$$
);
