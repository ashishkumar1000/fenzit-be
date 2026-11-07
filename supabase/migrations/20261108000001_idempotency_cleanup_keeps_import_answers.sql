-- Staff bulk customer import keeps its finished answer for good, so a retry
-- after any delay replays it instead of running the import again (see
-- src/customers/import/import-commit.replay.ts). The hourly cleanup from
-- 20260621000012 deleted every idempotency_log row older than 24 hours, which
-- would have let a retry a day later write a second batch and audit entry.
--
-- This reschedules the same job to skip the import scope. Every other scope
-- keeps the 24-hour cleanup it had before.
SELECT cron.unschedule('idempotency-log-cleanup') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'idempotency-log-cleanup'
);
SELECT cron.schedule(
  'idempotency-log-cleanup',     -- unique job name
  '0 * * * *',                   -- every hour
  $$DELETE FROM idempotency_log
      WHERE created_at < now() - interval '24 hours'
        AND scope IS DISTINCT FROM 'POST:/customers/import/commit'$$
);
