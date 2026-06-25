-- Enable pg_cron extension for scheduled cleanup jobs (Story 4.2, FR-17).
-- pg_cron runs inside the database as a background worker; jobs are stored in
-- the cron.job table and survive restarts.
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

-- Grant the postgres role (Supabase superuser) usage on the cron schema so
-- the schedule calls below can register jobs.
GRANT USAGE ON SCHEMA cron TO postgres;

-- Cleanup 1: idempotency_log — remove rows older than 24 hours (FR-17).
-- The IdempotencyInterceptor already filters created_at > now() - 24h in its
-- lookup, so un-pruned rows never replay past their window. This job is purely
-- for table hygiene / unbounded growth prevention (deferred W1 from Story 3.5).
-- Schedule: every hour at :00.
-- Unschedule first so re-running this migration (branch reset, db reset) does not
-- register a duplicate job — pg_cron does not enforce unique job names.
SELECT cron.unschedule('idempotency-log-cleanup') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'idempotency-log-cleanup'
);
SELECT cron.schedule(
  'idempotency-log-cleanup',     -- unique job name
  '0 * * * *',                   -- every hour
  $$DELETE FROM idempotency_log WHERE created_at < now() - interval '24 hours'$$
);

-- Cleanup 2: attachment_uploads — remove expired/abandoned staging rows
-- (deferred A3 from Story 3.6 code review). Rows that never reached
-- status='confirmed' past expires_at accumulate indefinitely without this job.
-- The condition keeps a 1-day grace buffer beyond the row's own expires_at
-- (industry standard: short active TTL + grace period for auditability/clock-skew).
-- Schedule: once per day at 03:00 UTC.
SELECT cron.unschedule('attachment-uploads-cleanup') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'attachment-uploads-cleanup'
);
SELECT cron.schedule(
  'attachment-uploads-cleanup',   -- unique job name
  '0 3 * * *',                    -- daily at 03:00 UTC
  $$DELETE FROM attachment_uploads WHERE expires_at < now() - interval '1 day'$$
);
