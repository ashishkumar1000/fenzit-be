-- Story 3.1: prune owner notifications (bounded table growth).
-- Mirrors the pg_cron convention of 20260621000012_pg_cron_idempotency_cleanup.sql:
-- extension guard + usage grant + idempotent re-run (unschedule-then-schedule).
--
-- Retention: rows older than 30 days are deleted UNLESS they are Phase-2 push
-- queue entries — a row with pushed_at IS NULL younger than 90 days is a push
-- that was never sent (the Phase 2 worker doesn't exist yet, so ALL rows are
-- unsent today; the 90-day arm retains unsent rows for 90 days).
-- Once Phase 2 lands, sent rows (pushed_at set) die at 30 days.
-- Schedule: hourly at :10 (the existing idempotency job runs at :00 — avoid
-- stacking both deletes on the same tick).

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

GRANT USAGE ON SCHEMA cron TO postgres;

SELECT cron.unschedule('notifications-cleanup') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'notifications-cleanup'
);
SELECT cron.schedule(
  'notifications-cleanup',       -- unique job name
  '10 * * * *',                  -- every hour at :10
  $$DELETE FROM notifications WHERE created_at < now() - interval '30 days' AND (pushed_at IS NOT NULL OR created_at < now() - interval '90 days')$$
);
